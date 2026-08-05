/**
 * Popup —— 一键自检
 *
 * 注意：popup 自己是一个扩展页面，它的 fetch 不会被 hook。
 * 所以自检必须用 chrome.scripting.executeScript 注入到【页面的 MAIN world】里去跑。
 */

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', refresh);
$('run').addEventListener('click', runSelfTest);
$('refresh').addEventListener('click', refresh);
$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR' });
  refresh();
});

/** 这个函数体会被序列化后送进页面的 MAIN world 执行 */
function pageSelfTest() {
  const api = window.__MOCK_SPIKE__;
  if (!api) return { injected: false };
  return api.test().then((r) => ({
    injected: true,
    timing: api.timing,
    hooked: api.isHooked(),
    wrapperInfo: api.wrapperInfo(),
    result: r,
  }));
}

async function runSelfTest() {
  $('verdict').textContent = '运行中…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !/^https?:/.test(tab.url || '')) {
    $('verdict').innerHTML = '<span class="bad">✗ 当前标签页不是 http(s) 页面</span>';
    $('out').textContent = '请在你司实际业务站点上打开本弹窗再试。\nchrome:// 和扩展页面无法注入。';
    return;
  }

  let res;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: pageSelfTest,
    });
    res = result;
  } catch (e) {
    $('verdict').innerHTML = '<span class="bad">✗ 注入失败</span>';
    $('out').textContent = String(e);
    return;
  }

  if (!res || !res.injected) {
    $('verdict').innerHTML =
      '<span class="bad">✗ 注入脚本没跑起来</span>';
    $('out').textContent =
      '页面里找不到 __MOCK_SPIKE__。可能原因：\n' +
      '1. 装好插件后没有刷新页面（注入脚本只在页面加载时执行）\n' +
      '2. 该站点有严格 CSP 或企业策略阻止了扩展注入\n' +
      '3. Chrome 版本低于 111（不支持 world: MAIN）';
    return;
  }

  const fetchOk = res.result?.fetch?.__mocked_by__ === 'spike';
  const xhrOk = res.result?.xhr?.__mocked_by__ === 'spike';
  const early = res.timing?.scriptCountAtInstall === 0;
  const wrapped = !(res.hooked?.fetch && res.hooked?.xhr);

  const lines = [];
  lines.push(fetchOk ? '<span class="ok">✓ fetch 拦截并改写成功</span>'
                     : '<span class="bad">✗ fetch 改写失败</span>');
  lines.push(xhrOk ? '<span class="ok">✓ XHR 拦截并改写成功（axios 走这条）</span>'
                   : '<span class="bad">✗ XHR 改写失败</span>');
  lines.push(early ? '<span class="ok">✓ 注入时机足够早（页面脚本之前）</span>'
                   : '<span class="warn">⚠ 注入时已有 ' + res.timing?.scriptCountAtInstall +
                     ' 个脚本执行过，可能漏拦早期请求</span>');

  // 关键修正：判据是「mock 是否实际生效」（行为），不是「我们是否最外层」（结构）。
  // 页面在我们之后包一层是常态（监控 SDK），只要我们在最底层、mock 仍生效，就没问题。
  if (!wrapped) {
    lines.push('<span class="ok">✓ 我们的 hook 位于最外层</span>');
  } else if (fetchOk && xhrOk) {
    lines.push(
      '<span class="warn">⚠ 页面在我们之后又包了一层（多为监控/APM SDK）—— ' +
        '但因我们注入最早、处于调用链最底层，mock 仍然生效，无碍</span>'
    );
  } else {
    lines.push(
      '<span class="bad">✗ 被页面覆盖且 mock 未生效 —— 需要针对性对抗</span>'
    );
  }

  // 行为判据：只要 fetch/XHR mock 都生效，方案就成立。
  // 注入时机晚（early=false）只是警告，不阻塞结论。
  const pass = fetchOk && xhrOk;
  lines.unshift(
    pass
      ? '<strong class="ok">结论：方案可行 ✓</strong>' +
          (wrapped ? '<br><span class="sub" style="font-weight:400">（站点存在请求包装层，已确认不影响 mock）</span>' : '')
      : '<strong class="bad">结论：存在阻塞问题，方案需调整</strong>'
  );

  $('verdict').innerHTML = lines.join('<br>');
  $('out').textContent = JSON.stringify(res, null, 2);
  refresh(true);
}

async function refresh(keepOut) {
  let r;
  try {
    r = await chrome.runtime.sendMessage({ type: 'GET_REPORT' });
  } catch (e) {
    return;
  }
  if (!r) return;

  $('ready').textContent = r.timing?.readyState ?? '—';
  const sc = r.timing?.scriptCountAtInstall;
  $('scripts').textContent = sc === undefined ? '—' : sc;
  $('scripts').className = 'val ' + (sc === 0 ? 'ok' : sc > 0 ? 'warn' : '');
  $('nfetch').textContent = r.byApi?.fetch ?? 0;
  $('nxhr').textContent = r.byApi?.xhr ?? 0;
  $('nmock').textContent = r.mocked ?? 0;

  if (r.stillHooked) {
    const topLevel = r.stillHooked.fetch && r.stillHooked.xhr;
    $('hooked').textContent = topLevel ? '最外层' : '最底层（被包裹）';
    $('hooked').className = 'val ' + (topLevel ? 'ok' : 'warn');
  }

  if (!keepOut && r.recent?.length) {
    $('out').textContent = r.recent
      .map((e) => `${e.kind === 'mock' ? '[MOCK]' : '      '} ${e.method} ${e.api.padEnd(5)} ${e.url}`)
      .join('\n');
  }
}
