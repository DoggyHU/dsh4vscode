# 发布到 VS Code Marketplace

本插件已完成 GitHub 推送（`v0.1.0` tag）。要让它出现在 **VS Code 扩展面板的搜索**里，需要发布到 VS Code Marketplace（官方市场）。

## 前置：准备发布凭证（一次性，约 5 分钟，免费，不需要绑信用卡）

### 1. 创建 Publisher（发布者）

1. 打开 https://marketplace.visualstudio.com/manage
2. 用微软账号登录（没有就注册一个，QQ 邮箱即可）
3. 按引导 **Create Publisher**：
   - **Name**：全网唯一的小写 ID（本项目用 `doggyhu`）
   - **Display name**：显示名（如 `DoggyHU`）

### 2. 创建 PAT（发布令牌）

1. 打开 https://dev.azure.com （同一微软账号）
2. 右上角头像 → **User settings** → **Personal Access Tokens** → **+ New Token**
3. 填写：
   - Name：`vsce-publish`
   - Organization：`All accessible organizations`
   - Expiration：`1 year`
   - Scopes：**Show all scopes** → 找到 **Marketplace** → 勾选 **Acquire** + **Manage**
4. **Create** → 立刻复制 token（只显示一次）

> 如果页面要求创建 Organization：随便填个名字创建即可，免费，不影响。

## 发布

```bash
# 方式 A：环境变量（推荐，token 不进 shell 历史）
$env:VSCE_PAT = "<你的PAT>"
npx @vscode/vsce publish --skip-license-check

# 方式 B：交互式登录
npx @vscode/vsce login doggyhu    # 粘贴 PAT
npx @vscode/vsce publish --skip-license-check
```

发布前本地验证打包：

```bash
npx @vscode/vsce package --allow-missing-repository
```

发布成功后：

- 打开 https://marketplace.visualstudio.com/manage 可管理扩展（更新说明、徽标等）
- VS Code 扩展面板搜索 `dsh` 即可找到（一般几分钟内生效）
- 后续版本发布：改 `package.json` 的 `version` → `vsce publish`

## 备选：Open VSX（VS Code 的替代市场）

不依赖微软账号，用 GitHub 账号即可：

```bash
npx ovsx publish dsh4vscode-0.1.0.vsix -p <GITHUB_TOKEN>
```

## 发布前检查清单

- [ ] `package.json` 的 `publisher` 字段 == Azure 创建的 Publisher Name（当前为 `doggyhu`）
- [ ] `repository` 字段指向 GitHub 仓库（建议加上）
- [ ] `icon` 字段指向 128x128 PNG（Marketplace 列表图标，当前未设置，会用默认）
- [ ] `version` 语义化版本号
