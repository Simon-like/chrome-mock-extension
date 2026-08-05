/**
 * ISOLATED world 内容脚本 —— 中继站
 *
 * MAIN world 用不了 chrome.*，所以它把数据 postMessage 出来，
 * 由这里接住，再用 chrome.runtime 转发给 Service Worker。
 *
 * 这条 MAIN → ISOLATED → SW 的链路，就是正式产品的主动脉。
 */
(function () {
  'use strict';

  const CHANNEL = '__MOCK_SPIKE__';

  window.addEventListener('message', (event) => {
    // 安全校验：postMessage 是页面也能伪造的，必须验来源
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    try {
      chrome.runtime.sendMessage({ type: 'SPIKE_EVENT', payload: data });
    } catch (e) {
      // SW 正在重启时 sendMessage 会抛错，Spike 阶段忽略即可
    }
  });
})();
