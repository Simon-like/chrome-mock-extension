/**
 * devtools_page 本身没有 UI，唯一职责是注册面板。
 * 真正的界面在 panel.html。
 */

chrome.devtools.panels.create('Mock', '', 'src/hosts/devtools/panel.html');
