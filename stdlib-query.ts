/**
 * FreeLang v2 stdlib — react-query 네이티브 구현
 *
 * npm @tanstack/react-query 완전 대체 (외부 npm 0개)
 * 메모리 기반 캐시 + 재시도 로직 + 뮤테이션 관리
 *
 * 등록 함수:
 *   query_client_create(staleTime, cacheTime, retry, refetchInterval) → clientId
 *   query_cache_get(clientId, key)           → { data, timestamp } | null
 *   query_cache_set(clientId, key, data)     → void
 *   query_cache_invalidate(clientId, prefix) → int
 *   query_cache_gc(clientId)                 → int
 *   query_is_stale(clientId, key)            → bool
 *   query_fetch_with_retry(fetchFn, retryCount) → { data, error, success }
 *   query_mutation_create(clientId)          → mutationId
 *   query_mutation_execute(mutationId, mutateFn, data) → { data, error, success }
 *   query_key_serialize(keyArray)            → string
 *   query_now()                              → int (ms timestamp)
 */

import { NativeFunctionRegistry } from './vm/native-function-registry';

// ============================================
// 내부 타입
// ============================================

interface CacheEntry {
  data: unknown;
  timestamp: number;      // 저장 시각 (ms)
  lastAccessed: number;   // 마지막 접근 시각
}

interface ClientConfig {
  staleTime: number;
  cacheTime: number;
  retry: number;
  refetchInterval: number;
}

interface ClientState {
  config: ClientConfig;
  cache: Map<string, CacheEntry>;
}

interface MutationState {
  clientId: number;
  status: 'idle' | 'loading' | 'success' | 'error';
}

// ============================================
// 전역 상태
// ============================================

let clientCounter = 1;
let mutationCounter = 1;

const clients  = new Map<number, ClientState>();
const mutations = new Map<number, MutationState>();

// ============================================
// 헬퍼
// ============================================

/** key 배열 → "users|42" 형태 문자열 */
function serializeKey(keyArg: unknown): string {
  if (Array.isArray(keyArg)) {
    return keyArg.map(String).join('|');
  }
  if (typeof keyArg === 'string') return keyArg;
  return String(keyArg);
}

/** fetchFn을 호출 (FL 함수 또는 JS 함수 처리) */
async function callFn(fn: unknown, arg?: unknown): Promise<unknown> {
  if (typeof fn === 'function') {
    const result = arg !== undefined ? (fn as Function)(arg) : (fn as Function)();
    if (result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
      return await result;
    }
    return result;
  }
  throw new Error('fetchFn이 함수가 아닙니다');
}

/** exponential backoff 대기 */
function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

/** 동기 sleep (짧은 재시도 대기용) */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait */ }
}

// ============================================
// 네이티브 함수 등록
// ============================================

export function registerQueryFunctions(registry: NativeFunctionRegistry): void {

  // query_client_create(staleTime, cacheTime, retry, refetchInterval) → clientId
  registry.register({
    name: 'query_client_create',
    module: 'query',
    executor: (args) => {
      const staleTime        = Number(args[0] ?? 0);
      const cacheTime        = Number(args[1] ?? 300000);
      const retry            = Number(args[2] ?? 3);
      const refetchInterval  = Number(args[3] ?? 0);

      const id = clientCounter++;
      clients.set(id, {
        config: { staleTime, cacheTime, retry, refetchInterval },
        cache: new Map()
      });
      return id;
    }
  });

  // query_cache_get(clientId, key) → { data, timestamp } | null
  registry.register({
    name: 'query_cache_get',
    module: 'query',
    executor: (args) => {
      const id  = Number(args[0]);
      const key = String(args[1]);
      const client = clients.get(id);
      if (!client) return null;

      const entry = client.cache.get(key);
      if (!entry) return null;

      // cacheTime 초과 시 null 반환 및 GC
      if (Date.now() - entry.timestamp > client.config.cacheTime) {
        client.cache.delete(key);
        return null;
      }

      entry.lastAccessed = Date.now();
      return { data: entry.data, timestamp: entry.timestamp };
    }
  });

  // query_cache_set(clientId, key, data) → void
  registry.register({
    name: 'query_cache_set',
    module: 'query',
    executor: (args) => {
      const id   = Number(args[0]);
      const key  = String(args[1]);
      const data = args[2];
      const client = clients.get(id);
      if (!client) return null;

      const now = Date.now();
      client.cache.set(key, { data, timestamp: now, lastAccessed: now });
      return null;
    }
  });

  // query_cache_invalidate(clientId, prefix) → int (삭제된 항목 수)
  // prefix="" 이면 전체 삭제
  registry.register({
    name: 'query_cache_invalidate',
    module: 'query',
    executor: (args) => {
      const id     = Number(args[0]);
      const prefix = String(args[1] ?? '');
      const client = clients.get(id);
      if (!client) return 0;

      let count = 0;
      if (!prefix) {
        count = client.cache.size;
        client.cache.clear();
        return count;
      }

      for (const key of [...client.cache.keys()]) {
        if (key.startsWith(prefix)) {
          client.cache.delete(key);
          count++;
        }
      }
      return count;
    }
  });

  // query_cache_gc(clientId) → int (GC된 항목 수)
  registry.register({
    name: 'query_cache_gc',
    module: 'query',
    executor: (args) => {
      const id = Number(args[0]);
      const client = clients.get(id);
      if (!client) return 0;

      const now = Date.now();
      let count = 0;
      for (const [key, entry] of client.cache.entries()) {
        if (now - entry.lastAccessed > client.config.cacheTime) {
          client.cache.delete(key);
          count++;
        }
      }
      return count;
    }
  });

  // query_is_stale(clientId, key) → bool
  registry.register({
    name: 'query_is_stale',
    module: 'query',
    executor: (args) => {
      const id  = Number(args[0]);
      const key = String(args[1]);
      const client = clients.get(id);
      if (!client) return true;

      const entry = client.cache.get(key);
      if (!entry) return true;

      return (Date.now() - entry.timestamp) > client.config.staleTime;
    }
  });

  // query_fetch_with_retry(fetchFn, retryCount) → { data, error, success }
  registry.register({
    name: 'query_fetch_with_retry',
    module: 'query',
    executor: (args) => {
      const fetchFn    = args[0];
      const retryCount = Number(args[1] ?? 3);

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          let result: unknown;

          if (typeof fetchFn === 'function') {
            const ret = (fetchFn as Function)();
            // Promise인 경우 동기 처리 불가 → 결과를 직접 반환
            if (ret && typeof ret === 'object' && typeof (ret as Promise<unknown>).then === 'function') {
              // Promise는 결과를 기다릴 수 없으므로 thenable 처리
              let resolved: unknown = null;
              let rejected: unknown = null;
              let done = false;
              (ret as Promise<unknown>)
                .then(v => { resolved = v; done = true; })
                .catch(e => { rejected = e; done = true; });

              // 짧은 대기 (동기 환경에서 최선)
              const deadline = Date.now() + 5000;
              while (!done && Date.now() < deadline) {
                sleepSync(10);
              }

              if (rejected !== null) throw rejected;
              result = resolved;
            } else {
              result = ret;
            }
          } else {
            return { data: null, error: 'fetchFn이 함수가 아닙니다', success: false };
          }

          return { data: result, error: '', success: true };
        } catch (e: unknown) {
          if (attempt < retryCount) {
            sleepSync(backoffMs(attempt));
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          return { data: null, error: msg, success: false };
        }
      }

      return { data: null, error: '알 수 없는 오류', success: false };
    }
  });

  // query_mutation_create(clientId) → mutationId
  registry.register({
    name: 'query_mutation_create',
    module: 'query',
    executor: (args) => {
      const clientId = Number(args[0]);
      const id = mutationCounter++;
      mutations.set(id, { clientId, status: 'idle' });
      return id;
    }
  });

  // query_mutation_execute(mutationId, mutateFn, data) → { data, error, success }
  registry.register({
    name: 'query_mutation_execute',
    module: 'query',
    executor: (args) => {
      const mutationId = Number(args[0]);
      const mutateFn   = args[1];
      const data       = args[2];

      const mut = mutations.get(mutationId);
      if (!mut) return { data: null, error: '뮤테이션을 찾을 수 없습니다', success: false };

      mut.status = 'loading';
      try {
        let result: unknown;
        if (typeof mutateFn === 'function') {
          result = (mutateFn as Function)(data);
          // Promise 처리
          if (result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
            let resolved: unknown = null;
            let rejected: unknown = null;
            let done = false;
            (result as Promise<unknown>)
              .then(v => { resolved = v; done = true; })
              .catch(e => { rejected = e; done = true; });
            const deadline = Date.now() + 5000;
            while (!done && Date.now() < deadline) sleepSync(10);
            if (rejected !== null) throw rejected;
            result = resolved;
          }
        } else {
          throw new Error('mutateFn이 함수가 아닙니다');
        }
        mut.status = 'success';
        return { data: result, error: '', success: true };
      } catch (e: unknown) {
        mut.status = 'error';
        const msg = e instanceof Error ? e.message : String(e);
        return { data: null, error: msg, success: false };
      }
    }
  });

  // query_key_serialize(keyArray) → string
  registry.register({
    name: 'query_key_serialize',
    module: 'query',
    executor: (args) => serializeKey(args[0])
  });

  // query_now() → int (현재 ms timestamp)
  registry.register({
    name: 'query_now',
    module: 'query',
    executor: () => Date.now()
  });
}
