# Mock Studio

Mock Studio 是一个 Chrome 扩展。你可以从浏览器里的一条真实请求创建 Mock，改几项返回数据，就能测试空列表、接口报错或加载慢等场景。后端接口还没做好时，也可以先建一条虚拟接口。

规则保存在浏览器本地，安装后即可手动使用。无需登录，也无需改业务代码。

## 安装

需要 Chrome 116 或更新版本。

1. 下载并解压 [Mock Studio 1.0.0-beta 安装包](https://github.com/Simon-like/chrome-mock-extension/releases/download/v1.0.0-beta/mock-studio-extension-v1.0.0-beta.zip)。
2. 在 Chrome 地址栏打开 `chrome://extensions`，开启右上角的 **开发者模式**。
3. 点 **加载已解压的扩展程序**，选择包含 `manifest.json` 的目录。
4. 首次安装会打开规则管理页，顶部有上手提示。开始调试前，先刷新目标网页。

## 创建第一条 Mock

1. 在目标网页打开 Chrome 开发者工具，切到 **Mock** 面板。看不到时，在开发者工具标签栏的 **»** 菜单里找。
2. 触发一次要调试的请求，选中它并点 **转为 Mock**。编辑器会带入真实响应。
3. 修改响应并保存，再触发一次请求查看结果。例如，把列表字段改成 `[]`，就能检查页面的空状态。

想先开发一个后端还没提供的接口？点扩展图标 → **管理规则** → **新建规则**，选择 **新建虚拟接口**。

## 让 AI 帮你 Mock（可选）

在规则管理页打开 **MCP**，启用后按面板提示连接你的 AI 客户端。接好后，可以直接说「把当前页面的商品列表改成空数据，帮我测一下空状态」。

如果要使用与扩展同版本的 MCP 服务，可以从 [Beta 发布页](https://github.com/Simon-like/chrome-mock-extension/releases/tag/v1.0.0-beta) 下载单文件，按同页的 `INSTALL.md` 接入。客户端配置、使用示例和排错见 [MCP 使用指南](./docs/guides/mcp-usage.md)。

[全部版本](../../releases) · [从源码构建](./docs/guides/development-workflow.md) · [Mock 模板语法](./docs/reference/mock-template-syntax.md) · [项目文档](./docs/README.md)
