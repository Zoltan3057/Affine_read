import { AffineContext } from '@affine/core/components/context';
import { AppContainer } from '@affine/core/desktop/components/app-container';
import { router } from '@affine/core/desktop/router';
import { configureCommonModules } from '@affine/core/modules';
import { I18nProvider } from '@affine/core/modules/i18n';
import { LifecycleService } from '@affine/core/modules/lifecycle';
import {
  configureLocalStorageStateStorageImpls,
  NbstoreProvider,
} from '@affine/core/modules/storage';
import { PopupWindowProvider } from '@affine/core/modules/url';
import { configureBrowserWorkbenchModule } from '@affine/core/modules/workbench';
import { configureBrowserWorkspaceFlavours } from '@affine/core/modules/workspace-engine';
import createEmotionCache from '@affine/core/utils/create-emotion-cache';
import { getWorkerUrl } from '@affine/env/worker';
import { StoreManagerClient } from '@affine/nbstore/worker/client';
import { setTelemetryTransport } from '@affine/track';
import { CacheProvider } from '@emotion/react';
import { Framework, FrameworkRoot, getCurrentStore } from '@toeverything/infra';
import { OpClient } from '@toeverything/infra/op';
import { Suspense } from 'react';
import { RouterProvider } from 'react-router-dom';

// Tailwind CSS 确实是 Emotion 最主要的替代方向
const cache = createEmotionCache();

// 此时 storeManagerClient 的值是 undefined，它还不是任何实例。它只是一个“声明为将来装 StoreManagerClient 实例的变量”。
// 先声明，后面根据环境分支赋值。
let storeManagerClient: StoreManagerClient;

// 启动数据 Worker
// 根据当前构建环境（dev/prod、browser/electron 等）返回 nbstore Worker 脚本的 URL。
const workerUrl = getWorkerUrl('nbstore');

// 为什么优先 SharedWorker：多标签页共享同一个存储 Worker，避免多个标签同时打开 IndexedDB 造成锁冲突、数据不一致，也节省资源。
if (
  window.SharedWorker &&
  localStorage.getItem('disableSharedWorker') !== 'true'
) {
  const worker = new SharedWorker(workerUrl, {
    name: 'affine-shared-worker',
  });
  // OpClient: 把 port 包装成 RPC 客户端。
  // StoreManagerClient: 再包装成 nbstore 专用客户端。
  // SharedWorker 通过 port 通信，不是直接 worker.postMessage。
  storeManagerClient = new StoreManagerClient(new OpClient(worker.port));
} else {
  const worker = new Worker(workerUrl);
  storeManagerClient = new StoreManagerClient(new OpClient(worker));
}

// 这样埋点数据通过 Worker 异步上报，不阻塞主线程。
setTelemetryTransport(storeManagerClient.telemetry);
window.addEventListener('beforeunload', () => {
  storeManagerClient.dispose(); // 页面即将关闭/刷新时 dispose()，释放 Worker 资源、关闭连接。
});
window.addEventListener('focus', () => {
  storeManagerClient.resume(); // 用户回到页面或点击时 resume()，恢复同步。
});
window.addEventListener('click', () => {
  storeManagerClient.resume();
});
window.addEventListener('blur', () => {
  storeManagerClient.pause(); // 页面失焦时 pause()，暂停后台同步，省资源。
});

const framework = new Framework(); // 创建依赖注入容器。
configureCommonModules(framework); // 注册通用模块（与平台无关）。
configureBrowserWorkbenchModule(framework); // 注册浏览器端工作台模块——这再次证明这是 Web 入口。
configureLocalStorageStateStorageImpls(framework); // 注册基于 localStorage 的状态持久化实现。
configureBrowserWorkspaceFlavours(framework); // 注册浏览器端的工作区类型（flavours）。本地，云端
// 以后谁要 NbstoreProvider 这个接口，就给他这个由 storeManagerClient 驱动的实现
framework.impl(NbstoreProvider, {
  realtime: storeManagerClient.realtime,
  openStore(key, options) {
    return storeManagerClient.open(key, options);
  },
});

// 弹窗抽象接口。
// 走本站的 /redirect-proxy，把目标 URL 放在 redirect_uri 参数里，由代理页跳转。这样避免直接打开外链带来的 referrer 泄露、被弹窗拦截等问题。
framework.impl(PopupWindowProvider, {
  open: (target: string) => {
    const targetUrl = new URL(target);

    let url: string;
    // safe to open directly if in the same origin
    if (targetUrl.origin === location.origin) {
      url = target;
    } else {
      const redirectProxy = location.origin + '/redirect-proxy';
      const search = new URLSearchParams({
        redirect_uri: target,
      });

      url = `${redirectProxy}?${search.toString()}`;
    }
    window.open(url, '_blank', 'popup noreferrer noopener');
  },
});
const frameworkProvider = framework.provider();

// setup application lifecycle events, and emit application start event
// 注册一个窗口聚焦事件的监听器，并主动通知应用“已经启动”。
window.addEventListener('focus', () => {
  frameworkProvider.get(LifecycleService).applicationFocus();
});
frameworkProvider.get(LifecycleService).applicationStart();

export function App() {
  return (
    // 懒加载组件未就绪时显示兜底 UI（AppContainer 的 fallback 模式）。
    // 把 DI 容器注入 React 上下文，子组件可通过 hooks 取服务。
    // 注入第 20 行创建的 Emotion 缓存。
    // <I18nProvider>：国际化上下文。
    // <AffineContext store={getCurrentStore()}>：提供全局 store。
    // React Router 接管路由，渲染实际页面。
    <Suspense fallback={<AppContainer fallback />}>
      <FrameworkRoot framework={frameworkProvider}>
        <CacheProvider value={cache}>
          <I18nProvider>
            <AffineContext store={getCurrentStore()}>
              <RouterProvider router={router} />
            </AffineContext>
          </I18nProvider>
        </CacheProvider>
      </FrameworkRoot>
    </Suspense>
  );
}
