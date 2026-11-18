// LiveData 单元测试。
// 覆盖：基础读写、从 Observable 派生（LiveData.from）、错误中毒（poisoned）、
// map 派生、与 RxJS 互操作、嵌套扁平化（flat）以及 computed 派生计算。
import type { Subscriber } from 'rxjs';
import { combineLatest, Observable, of } from 'rxjs';
import { describe, expect, test, vitest } from 'vitest';

import { LiveData, PoisonedError } from '..';

describe('livedata', () => {
  test('LiveData', async () => {
    // 基础读写：构造时带初始值；value 同步读取；next 同步更新当前值
    const livedata$ = new LiveData(0);
    expect(livedata$.value).toBe(0);
    livedata$.next(1);
    expect(livedata$.value).toBe(1);

    // 订阅语义：订阅后能收到后续 next 发出的值（真实场景中派发可能是异步的，这里用 waitFor 兜底）
    let subscribed = 0;
    livedata$.subscribe(v => {
      subscribed = v;
    });
    livedata$.next(2);
    expect(livedata$.value).toBe(2);
    // vitest.waitFor(fn) 是轮询 fn() 的返回值，直到返回真值。适合"我不知道它什么时候好，但我知道好了的标志是什么"的场景，比如等待 DOM 更新、异步状态同步、订阅回调触发。
    await vitest.waitFor(() => subscribed === 2);
  });

  test('from', async () => {
    // 1) 从同步 Observable 创建：读取 value 会临时触发一次 watch，
    //    of(1, 2, 3, 4) 被同步订阅并依次发出，因此最终值为最后一个值 4
    {
      const livedata$ = LiveData.from(of(1, 2, 3, 4), 0);
      // .value：只要"最终结果"，中间值被覆盖，只返回最后一个。
      // .subscribe(cb)：要"变化过程"，每个发出的值都会回调，1、2、3、4 一个不少。
      expect(livedata$.value).toBe(4);
    }

    // 2) 从受控 Observable 创建：订阅后先拿到初始值 0，
    //    上游每次手动 next 都会把值转发给订阅者
    {
      let subscriber: Subscriber<number> = null!;
      const observable$ = new Observable<number>(s => {
        subscriber = s;
      });
      const livedata$ = LiveData.from(observable$, 0);
      let value = 0;
      livedata$.subscribe(v => {
        value = v;
      });

      expect(value).toBe(0);
      subscriber.next(1);
      expect(value).toBe(1);
      subscriber.next(2);
      expect(value).toBe(2);
    }

    // 3) 懒订阅 + 自动清理：创建时不订阅上游；出现第一个订阅者时才订阅上游；
    //    取消订阅后执行上游的 teardown（observableClosed 变为 true）
    {
      let observableSubscribed = false;
      let observableClosed = false;
      const observable$ = new Observable(subscriber => {
        observableSubscribed = true;
        subscriber.next(1);
        return () => {
          observableClosed = true;
        };
      });
      const livedata$ = LiveData.from(observable$, 0);
      expect(observableSubscribed).toBe(false);
      const subscription = livedata$.subscribe(_ => {});
      expect(observableSubscribed).toBe(true);
      expect(observableClosed).toBe(false);
      subscription.unsubscribe();
      expect(observableClosed).toBe(true);
    }

    // 4) 多个订阅者共享同一个上游：一次上游 next 会广播给所有订阅者
    {
      let subscriber: Subscriber<number> = null!;
      const observable$ = new Observable<number>(s => {
        subscriber = s;
      });
      const livedata$ = LiveData.from(observable$, 0);
      let value1 = 0;
      livedata$.subscribe(v => {
        value1 = v;
      });

      let value2 = 0;
      livedata$.subscribe(v => {
        value2 = v;
      });

      expect(value1).toBe(0);
      expect(value2).toBe(0);
      subscriber.next(1);
      expect(value1).toBe(1);
      expect(value2).toBe(1);
      subscriber.next(2);
      expect(value1).toBe(2);
      expect(value2).toBe(2);
    }

    // 5) 引用计数：还有订阅者时上游保持订阅状态，
    //    直到最后一个订阅者取消订阅才关闭上游
    {
      let observableSubscribed = false;
      let observableClosed = false;
      const observable$ = new Observable(subscriber => {
        observableSubscribed = true;
        subscriber.next(1);
        return () => {
          observableClosed = true;
        };
      });
      const livedata$ = LiveData.from(observable$, 0);
      expect(observableSubscribed).toBe(false);
      const subscription1 = livedata$.subscribe(_ => {});
      const subscription2 = livedata$.subscribe(_ => {});
      expect(observableSubscribed).toBe(true);
      expect(observableClosed).toBe(false);
      subscription1.unsubscribe();
      expect(observableClosed).toBe(false);
      subscription2.unsubscribe();
      expect(observableClosed).toBe(true);
    }

    // 6) 去重订阅：无论有多少个订阅者，上游只会被订阅一次
    {
      let observerCount = 0;
      const observable$ = new Observable(_ => {
        observerCount++;
      });
      const livedata$ = LiveData.from(observable$, 0);
      livedata$.subscribe(_ => {});
      livedata$.subscribe(_ => {});
      expect(observerCount).toBe(1);
    }

    // 7) 读取 value 本身也会临时触发一次上游订阅（get -> watch），
    //    因此即使没有持久订阅者，每次读取都能拿到上游的最新值
    {
      let value = 0;
      const observable$ = new Observable<number>(subscriber => {
        subscriber.next(value);
      });
      const livedata$ = LiveData.from(observable$, 0);
      expect(livedata$.value).toBe(0);
      value = 1;
      expect(livedata$.value).toBe(1);
    }
  });

  test('poisoned', () => {
    // 上游抛错后 LiveData 进入不可恢复的“中毒”状态：
    // - 已订阅的观察者收到包装后的 PoisonedError；
    // - 之后调用 next / 读取 value 都会直接抛出 PoisonedError；
    // - 新的订阅者会立即收到 PoisonedError。
    {
      let subscriber: Subscriber<number> = null!;
      const livedata$ = LiveData.from<number>(
        new Observable(sub => {
          subscriber = sub;
        }),
        1
      );

      let value: number = 0;
      let error: any = null;
      livedata$.subscribe({
        next: v => {
          value = v;
        },
        error: e => {
          error = e;
        },
      });
      // 中毒前：正常转发上游的值
      expect(value).toBe(1);
      subscriber.next(2);
      expect(value).toBe(2);

      // 上游 error：观察者收到包装后的 PoisonedError
      expect(error).toBe(null);
      subscriber.error('error');
      expect(error).toBeInstanceOf(PoisonedError);

      // 中毒后：写入与读取都会抛错
      expect(() => livedata$.next(3)).toThrowError(PoisonedError);
      expect(() => livedata$.value).toThrowError(PoisonedError);

      // 新订阅者会立即收到 PoisonedError
      let error2: any = null;
      livedata$.subscribe({
        error: e => {
          error2 = e;
        },
      });
      expect(error2).toBeInstanceOf(PoisonedError);
    }
  });

  test('map', () => {
    // 1) 无订阅者时：map 返回的 LiveData 能同步读到派生值，源更新后派生值随之更新
    {
      const livedata$ = new LiveData(0);
      const mapped$ = livedata$.map(v => v + 1);
      expect(mapped$.value).toBe(1);
      livedata$.next(1);
      expect(mapped$.value).toBe(2);
    }

    // 2) 有订阅者时：订阅立即收到当前派生值（1），源更新后收到新的派生值（2）
    {
      const livedata$ = new LiveData(0);
      const mapped$ = livedata$.map(v => v + 1);
      let value = 0;
      mapped$.subscribe(v => {
        value = v;
      });
      expect(value).toBe(1);
      livedata$.next(1);
      expect(value).toBe(2);
    }

    // 3) 惰性传递：创建 map 时不订阅源；订阅派生 LiveData 时才订阅源；
    //    取消订阅后源被 teardown
    {
      let observableSubscribed = false;
      let observableClosed = false;
      const observable$ = new Observable<number>(subscriber => {
        observableSubscribed = true;
        subscriber.next(1);
        return () => {
          observableClosed = true;
        };
      });

      const livedata$ = LiveData.from(observable$, 0);
      const mapped$ = livedata$.map(v => v + 1);

      expect(observableSubscribed).toBe(false);
      const subscription = mapped$.subscribe(_ => {});
      expect(observableSubscribed).toBe(true);
      expect(observableClosed).toBe(false);
      subscription.unsubscribe();
      expect(observableClosed).toBe(true);
    }
  });

  test('interop with rxjs', () => {
    // LiveData 本身是 RxJS Observable，可直接参与 combineLatest 等 RxJS 操作符，
    // 且订阅时能立即拿到当前值
    const ob$ = combineLatest([new LiveData(1)]);
    let value = 0;
    ob$.subscribe(v => {
      value = v[0];
    });
    expect(value).toBe(1);
  });

  test('flat', () => {
    // 1) 单层嵌套：LiveData<LiveData<T>> 扁平化为 LiveData<T>；
    //    外层替换成新的 LiveData 时，自动切换到新内层的数据源
    {
      const wrapped$ = new LiveData(new LiveData(0));
      const flatten$ = wrapped$.flat();
      expect(flatten$.value).toBe(0);

      wrapped$.next(new LiveData(1));
      expect(flatten$.value).toBe(1);

      wrapped$.next(LiveData.from(of(2, 3), 0));
      expect(flatten$.value).toBe(3);
    }

    // 2) 递归深嵌套：LiveData<LiveData<LiveData<number>>[]> 会被完全展开（含数组元素）
    {
      const wrapped$ = new LiveData(
        new LiveData([
          new LiveData(new LiveData(1)),
          new LiveData(new LiveData(2)),
        ])
      );
      const flatten$ = wrapped$.flat();
      expect(flatten$.value).toStrictEqual([1, 2]);
    }

    // 3) 数组嵌套：LiveData<LiveData<T>[]> 扁平化为 LiveData<T[]>
    //    （用 combineLatest 聚合）；替换数组会重新聚合，内层变化会反映到外层
    {
      const wrapped$ = new LiveData([new LiveData(0), new LiveData(1)]);
      const flatten$ = wrapped$.flat();

      expect(flatten$.value).toEqual([0, 1]);

      const inner$ = new LiveData(2);
      wrapped$.next([inner$, new LiveData(3)]);
      expect(flatten$.value).toEqual([2, 3]);
      inner$.next(4);
      expect(flatten$.value).toEqual([4, 3]);
    }

    // 4) 空数组边界：直接得到 []，避免对空数组使用 combineLatest 导致永不发射
    {
      const wrapped$ = new LiveData([] as LiveData<number>[]);
      const flatten$ = wrapped$.flat();

      expect(flatten$.value).toEqual([]);
    }
  });

  test('computed', () => {
    // 1) 基本派生：b$ 由 a$ 计算得到（a + 1）
    {
      const a$ = new LiveData(1);
      const b$ = LiveData.computed(get => get(a$) + 1);
      expect(b$.value).toBe(2);
    }

    // 2) 动态依赖：根据 a$ 的值决定依赖 v1$ 还是 v2$，
    //    a$ 变化后会重新计算并切换依赖对象
    {
      const a$ = new LiveData('v1');
      const v1$ = new LiveData(100);
      const v2$ = new LiveData(200);

      const v$ = LiveData.computed(get => {
        return get(a$) === 'v1' ? get(v1$) : get(v2$);
      });

      expect(v$.value).toBe(100);

      a$.next('v2');
      expect(v$.value).toBe(200);
    }

    // 3) 懒计算 + 依赖引用计数：
    //    无人订阅时既不计算也不订阅依赖；
    //    首次订阅后才启动计算并订阅依赖；
    //    取消最后一个订阅后释放对依赖的订阅，且上游不会被重复订阅
    {
      let watched = false;
      let count = 0;
      let subscriber: Subscriber<number> = null!;
      const a$ = LiveData.from<number>(
        new Observable(sub => {
          count++;
          watched = true;
          subscriber = sub;
          sub.next(1);
          return () => {
            watched = false;
          };
        }),
        0
      );
      const b$ = LiveData.computed(get => get(a$) + 1);

      expect(watched).toBe(false);
      expect(count).toBe(0);

      const subscription = b$.subscribe(_ => {});
      expect(watched).toBe(true);
      expect(count).toBe(1);
      subscriber.next(2);
      expect(b$.value).toBe(3);

      subscription.unsubscribe();
      expect(watched).toBe(false);
      expect(count).toBe(1);
    }

    // 4) 循环依赖：b$ 与 c$ 互相依赖，递归层数超过上限后上游报错，
    //    LiveData 进入中毒状态，读取 value 抛出 PoisonedError
    {
      let c$ = null! as LiveData<number>;
      const b$ = LiveData.computed(get => get(c$) + 1);
      c$ = LiveData.computed(get => get(b$) + 1);

      expect(() => b$.value).toThrowError(PoisonedError);
    }
  });
});
