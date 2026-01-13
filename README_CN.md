# GithubCard

一个美观的自部署 Cloudflare Workers 单文件 GitHub 资料卡 SVG 生成器。

## 功能
- `/{username}` 返回 SVG 图片。
- 使用 GitHub GraphQL 获取近一年贡献与统计。
- 内置等级评分与百分位显示。
- 演示模式：`/{username}?demo=1` 或 `/test`（无需 Token）。
- 强制刷新：`/{username}?refresh=1` 绕过缓存一次。
- 主题：`?theme=dark`（默认）、`?theme=light`、`?theme=matrix`、`?theme=ayaka`、`?theme=sakura`（雪花+樱瓣纹理）。
- 可选 `LOCKED_USER` 环境变量，锁定只允许访问指定用户名。

## 获取 GitHub Token
1. GitHub → Settings → Developer settings → Personal access tokens。
2. 创建 Token（推荐 Fine-grained）。
3. Repository access：选择 **All public repositories**（或更小范围）。
4. Permissions：至少 `read:user`（若需要私有数据再加 `repo`）。
5. 生成并复制 Token（只会显示一次）。

## 主题预览

| 主题 | 预览 |
| --- | --- |
| Dark（默认） | ![dark](images/dark.svg) |
| Light | ![light](images/light.svg) |
| Matrix | ![matrix](images/matrix.svg) |
| Ayaka | ![ayaka](images/ayaka.svg) |
| Sakura（雪花+樱瓣） | ![sakura](images/sakura.svg) |

## 本地开发
1. 安装依赖
   ```bash
   npm install
   ```
2. 创建 `.dev.vars` 文件（给 `wrangler dev` 用）：
   ```
   GITHUB_TOKEN=ghp_your_token_here
   ```
3. 启动本地 Worker
   ```bash
   npm run dev
   ```
4. 访问 `http://localhost:8787/{github-name}`

## 部署
### Cloudflare 控制台（无需命令行）
1. Cloudflare Dashboard → Workers & Pages → Create → Worker → Start from scratch。
2. 打开 **Quick Edit / Edit code**，把默认代码替换为 `src/index.js`。
3. **Settings → Variables** 中添加 `GITHUB_TOKEN`，勾选加密。
4. 保存并部署。
5. 访问 `https://<your-worker>.workers.dev/{github-name}`（或 `/test` 预览）。

### Wrangler CLI
1. 登录 Wrangler：
   ```bash
   npx wrangler login
   ```
2. 添加 GitHub Token：
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
3. 部署：
   ```bash
   npm run deploy
   ```
4. 访问 `https://your-worker-domain/{github-name}`

## 备注
- GitHub Token 最小权限：`read:user` + 公开仓库读取即可。
- 缓存默认 1 小时，降低 API 频率。
- 评分与主题颜色可在 `src/index.js` 修改。
- 头像默认内联进 SVG，避免 GitHub README 里外链头像裂图；如需外链，使用 `?avatar=external`。
- 如需锁定只允许访问某个用户，设置 `LOCKED_USER`（控制台 Variables 或 `wrangler.toml`）：
  ```toml
  [vars]
  LOCKED_USER = "your_github_username"
  ```
