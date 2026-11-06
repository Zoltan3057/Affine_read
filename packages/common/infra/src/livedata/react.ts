import { useSyncExternalStore } from 'react';

import type { LiveData } from './livedata';

function noopSubscribe() {
  return () => {};
}

function nullGetSnapshot() {
  return null;
}

function undefinedGetSnapshot() {
  return undefined;
}

/**
 * subscribe LiveData and return the value.
 */
export function useLiveData<Input extends LiveData<any> | null | undefined>(
  liveData: Input
): NonNullable<Input> extends LiveData<infer T>
  ? Input extends undefined
    ? T | undefined
    : Input extends null
      ? T | null
      : T
  : never {
  // RxJS 是一个用 Observable（可观察对象） 来组合异步和基于事件的程序的 JavaScript 库。简单说，它把异步事件（如点击、HTTP 请求、定时器）当作“数据流”来处理，让你能用类似操作数组的方式（如 map、filter）去转换和组合这些流。、
  // useSyncExternalStore(subscribe, getSnapshot) 是 React 18 引入的官方 API，专门用来订阅 React 之外的数据源，保证并发渲染下不撕裂（tearing）。
  return useSyncExternalStore(
    liveData ? liveData.reactSubscribe : noopSubscribe,
    liveData
      ? liveData.reactGetSnapshot
      : liveData === undefined
        ? undefinedGetSnapshot
        : nullGetSnapshot
  );
}
