# 指南 02：申请 Microsoft Outlook 凭据（约 5 分钟）

> 用途：为 `email-mcp setup outlook` 提供 `client_id`（应用注册 ID）。
> **本工具采用 Device Code 授权流程，只需 client_id，不需要 client secret、不需要回调地址。**
> 个人 outlook.com 账号与 Office 365 企业账号均可，过程相同（企业租户可能需管理员同意，见文末）。

## 步骤 1：进入应用注册页面

1. 用目标 Outlook 邮箱账号登录 https://entra.microsoft.com
   - 若无法直接访问，可改走：https://portal.azure.com → 搜索 **App registrations（应用注册）**。
2. 左侧菜单 → **App registrations（应用注册）** → **New registration（新注册）**。

## 步骤 2：注册应用

填写：

- **Name**：`email-mcp`
- **Supported account types（支持的账户类型）**：
  - 个人 outlook.com 账号 → 选 **Personal Microsoft accounts only**
  - 或统一选 **Accounts in any organizational directory and personal Microsoft accounts**（最通用）
- **Redirect URI**：选 **Mobile and desktop applications** → URI 填 `http://localhost`
  - （Device Code 流程实际用不到回调，但配置此项无副作用，且为将来切换授权码流程留路。）
- 点 **Register（注册）**。

## 步骤 3：记录 client_id

注册完成后自动跳转到应用概览页，找到：

- **Application (client) ID**：形如 `11111111-2222-3333-4444-555555555555`

这就是 `email-mcp setup outlook` 需要的 `client_id`。

> 另可顺便记录 **Directory (tenant) ID**：个人账号场景无需填写（用默认 `common`），
> 企业账号若出问题可用它指定租户。

## 步骤 4：配置 API 权限（可选但推荐）

> 默认 scopes（`Mail.ReadWrite Mail.Send User.Read offline_access`）在授权时动态申请，
> 此步骤可选。提前配置的好处：企业租户可由管理员一次性"同意"。

1. 左侧菜单 → **API permissions（API 权限）** → **+ Add a permission**。
2. 选 **Microsoft Graph** → **Delegated permissions（委托的权限）**。
3. 搜索并勾选：`Mail.ReadWrite`、`Mail.Send`、`User.Read`
   （`offline_access` 与 `openid` 默认已包含）。
4. 点 **Add permissions**。
5. 权限列表顶部：
   - 个人账号：直接会以你的身份生效，无需额外操作；
   - 企业账号：点击 **Grant admin consent for ...（授予管理员同意）**（需要管理员权限）。

## 步骤 5：完成授权（运行时）

在终端运行 `email-mcp setup outlook`，程序会显示：

1. 一个网址：https://microsoft.com/devicelogin
2. 一串一次性代码，如 `ABCD-EFGH`

在**任何设备**（电脑/手机）的浏览器打开该网址，输入代码 → 用你的 Outlook 账号登录并
同意权限 → 回到终端，向导会自动完成配置。

## 常见问题

| 报错 / 现象 | 原因与解决 |
|---|---|
| device login 页面报 "code 已过期" | 重新运行 setup，用新 code（约 15 分钟内有效） |
| 同意后提示 `AADSTS65001`（无权限） | 企业租户：请管理员在步骤 4 授予管理员同意 |
| 提示 `invalid_client` | client_id 复制错了（注意是 Application (client) ID，不是 Directory ID） |
| 想换权限范围 | 重跑 setup outlook，重新授权即可 |

## 安全提醒

- client_id 本身不敏感，但**授权 token 敏感**：本工具存于 `~/.email-mcp/tokens/`（0600），
  不要外泄；如怀疑泄露，可在应用注册页 → **Certificates & secrets** 或权限页吊销。
- 企业账号的 token 有效期约 90 天（MSAL 会自动滚动刷新；长期不活跃需重新授权）。
