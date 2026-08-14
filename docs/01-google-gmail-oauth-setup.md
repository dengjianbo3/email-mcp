# 指南 01：申请 Google Gmail 凭据（约 5 分钟）

> 用途：为 `email-mcp setup gmail` 提供 `client_id` 和 `client_secret`。
> 全程在浏览器操作，无需写代码。**请使用你希望被读取邮件的那个 Google 账号登录。**

## 步骤 1：打开 Google Cloud Console 并新建项目

1. 访问 https://console.cloud.google.com ，用目标 Gmail 账号登录。
2. 顶部项目下拉框 → **新建项目**：
   - 项目名称：`email-mcp`（随意）
   - 点击 **创建**。
3. 确认右上角项目下拉框已选中该新项目。

## 步骤 2：启用 Gmail API

1. 左侧菜单 → **APIs & Services（API 和服务）** → **Library（库）**。
2. 搜索 `Gmail API` → 点击进入 → 点 **Enable（启用）**。
3. 稍等片刻，页面提示 API 已启用即可。

## 步骤 3：配置 OAuth 同意屏幕（Consent Screen）

1. 左侧菜单 → **APIs & Services** → **OAuth consent screen（OAuth 同意屏幕）**。
2. User Type 选 **External（外部）** → **Create（创建）**。
   - （说明：即使自己用也选 External 即可；Internal 需要 Google Workspace 组织账号。）
3. 填写必填项：
   - **App name**：`email-mcp`
   - **User support email**：你的邮箱
   - **Developer contact information**：你的邮箱
   - 其余可跳过 → **Save and Continue**。
4. Scopes 页：**跳过**（我们不需要手动声明，代码里会按需申请）→ **Save and Continue**。
5. Test users 页：**Add users** → 添加你自己的邮箱 → **Save and Continue** → 回到概览。
   - （External 应用发布前只有测试用户可用；自己用已足够，无需点击 "Publish app"。）

## 步骤 4：创建 OAuth Client ID（关键一步）

1. 左侧菜单 → **APIs & Services** → **Credentials（凭据）**。
2. 点 **+ Create Credentials（创建凭据）** → **OAuth client ID**。
3. 按如下填写：
   - **Application type（应用类型）**：选 **Desktop app（桌面应用）** ⚠️ 必须选这个
   - **Name**：`email-mcp`
   - 点 **Create（创建）**。
4. 弹窗中点击 **Download JSON**，下载 `client_secret_*.json` 保存好。

## 步骤 5：取出 client_id 和 client_secret

打开下载的 JSON 文件，找到两个字段：

```json
{
  "installed": {
    "client_id": "1234567890-abcdefghij.apps.googleusercontent.com",
    "client_secret": "GOCSPX-xxxxxxxxxxxxxxxxxxxx"
  }
}
```

- `client_id`：形如 `数字-字母.apps.googleusercontent.com`
- `client_secret`：形如 `GOCSPX-...`

把这两个值粘贴到 `email-mcp setup gmail` 的提示中即可。

## 常见问题

| 报错 / 现象 | 原因与解决 |
|---|---|
| 授权页提示 `redirect_uri_mismatch` | 步骤 4 应用类型选错（选了 Web application）。回到 Credentials 删除重建成 **Desktop app** |
| 授权页提示 "access blocked" | consent screen 未把该邮箱加入 Test users；或应用未发布 → 按步骤 3 添加测试用户 |
| 看不到 Gmail API | 确认步骤 2 已 Enable |
| 想改权限范围 | 重新运行 `email-mcp setup gmail`，在 scope 提示处重新选择即可（会重新授权一次） |

## 安全提醒

- `client_secret` 与 token 都属于敏感信息：**不要**提交到 git、不要发到聊天工具。
- 本工具把配置存放在 `~/.email-mcp/`（权限 0600），已隔离于项目目录。
- 如怀疑泄露：到 Google Cloud Console → Credentials → 删除该 OAuth Client 重建一个。
