# CloakBrowser 商业模式与功能关系分析

日期：2026-08-16  
范围：CloakBrowser 当前官网、公开仓库、本地 `E:\dev\CloakBrowser` 检出版本。  
证据标签：**Measured** 为官方页面或源码直接证据；**Inferred** 为基于证据的商业推断。

## 结论

CloakBrowser 不是按功能模块收费，而是采用“**开源获客、闭源二进制交付效果、并发量扩容、持续更新续费、支持与授权增收**”的模式。

它刻意让免费版和付费版使用相同的最新浏览器与核心功能。用户先用一并发在真实目标上验证效果，进入生产后再为 5、20、200、2,000 个并发会话付费。真正形成付费意愿的不是 `humanize=True`、GeoIP 或某个 API，而是：

1. 最新源码级补丁能否持续有效；
2. 同时能运行多少浏览器；
3. 出现兼容性问题时能否快速拿到修复和支持；
4. 是否有权把浏览器能力交付给第三方客户。

## 当前套餐与单位经济性

官网明确写明所有套餐运行同一个最新 v150，区别主要是并发量和支持等级。

| 套餐 | 当前促销价 / 标价 | 最大并发 | 促销价/并发/月 | 功能差异 |
| --- | ---: | ---: | ---: | --- |
| Free | $0 | 1 | $0 | 最新二进制、同一核心功能；GitHub 登录换免费 key |
| Solo | $19 / $29 | 5 | $3.80 | Hands-on support |
| Team | $49 / $79 | 20 | $2.45 | Hands-on support |
| Business | $199 / $249 | 200 | $1.00 | Priority support |
| Scale | $499 / $699 | 2,000 | $0.25 | Priority support |

**Measured**：官网价格与并发；**Calculated**：单位并发价格四舍五入。

从 Solo 到 Scale，促销单位并发价格下降约 15 倍。这不是云计算成本定价，而是典型的软件容量授权：客户自己承担机器、网络和代理成本，CloakHQ 用低边际成本出售更大的生产能力。大幅阶梯折扣鼓励客户把更多工作负载集中到同一个产品，也降低多买 key 或转向自建方案的动机。

## 商业杠杆与功能的对应关系

| 商业目标 | 对应功能/技术 | 关系 |
| --- | --- | --- |
| 降低获客成本 | MIT Python、JavaScript、.NET wrapper；标准 Playwright/Puppeteer API；三行启动 | 开源 SDK 和兼容 API 让开发者无需采购即可集成，社区还能贡献 Humanize、持久化、Docker、平台修复 |
| 保护核心价值 | 71 组 C++ 源码级补丁只存在于专有 Chromium 二进制 | SDK 可复制，但持续可用的浏览器补丁、构建与签名发布不可从仓库直接复制，是收费边界 |
| 让免费用户证明效果 | 最新构建免费 1 并发；自动下载；真实检测结果和演示 | 反检测工具必须在用户自己的目标上验证。免费旧版本会让产品显得无效，因此当前最新版本进入免费漏斗 |
| 从试用转生产付费 | 二进制内并发会话检查；清晰的 session-limit 错误；`info` 显示在用会话数 | 用户在真正产生吞吐需求时遇到自然升级点，收费指标与生产价值一致 |
| 维持月度续费 | Chromium 持续 rebase、Stable/Preview、自动更新、版本固定和回滚 | 反检测是持续对抗；订阅卖的是持续适配和新构建，而不是一次性软件副本 |
| 提高激活率 | CLI 的 login/install/info/update/cache；二进制自动下载并缓存 | 把 200MB 浏览器分发、版本选择、字体、GeoIP、依赖诊断包装成产品体验，减少安装失败和退款/support 工单 |
| 提升生产可用性 | Humanize、GeoIP、代理、持久化配置、扩展、Widevine、Docker、`cloakserve` | 这些功能不直接区分套餐，而是让更多工作负载能够进入生产，从而拉动并发购买 |
| 增加高端收入 | Business/Scale priority support；Enterprise 自定义；Cloud 托管 | 规模越大，兼容性故障价值越高，支持从成本中心变成付费价值；Cloud 则把自托管产品延伸为托管收入 |
| 防止渠道收入流失 | 普通订阅仅内部使用；第三方可控浏览器、嵌入、Browser-as-a-Service 需要 OEM/SaaS 协议 | 避免客户用一个普通并发套餐包装成自己的商业产品，单独捕获第三方分发价值 |
| 控制可变成本与风险 | 不内置代理轮换、不卖 CAPTCHA 求解；BYO proxy；本地/客户云运行 | 主订阅无需承担代理、验证码、浏览器小时和大规模基础设施成本，也降低滥用与合规风险 |
| 建立企业信任 | Ed25519 签名清单、版本绑定、防降级、缓存回退 | 专有二进制自动下载必须可验证，否则供应链风险会直接破坏企业购买意愿 |

## 产品增长闭环

```text
GitHub / PyPI / npm / Docker
        -> 标准 API 的首次成功运行
        -> GitHub 登录领取最新构建的 1 并发 key
        -> 真实目标验证隐身效果
        -> 并发不足或需要支持时购买 Solo / Team / Business / Scale
        -> Enterprise、Cloud 或 OEM/SaaS 协议
```

源码中还有明确的产品化转化机制：免费用户启动提示每三天重新出现；达到并发限制时错误文案直接引导关闭会话或升级；`info` 显示实时会话占用。这些不是普通诊断细节，而是把使用强度转换为购买意图的产品界面。

## 商业模式演变说明了什么

- **0.4.0（2026-06-22）**：首次推出 Pro，v148 最新二进制需要付费，v146 保持免费。此时主要用“版本新旧”做付费墙。
- **0.5.0（2026-07-22）**：增加 GitHub 免费 key，免费用户也能跟踪最新免费构建，但限制 1 并发。
- **当前官网**：明确声明所有套餐使用同一个最新 v150，用户只为并发扩容，并按规模获得 hands-on/priority support。

**Inferred**：版本功能墙妨碍了反检测产品最重要的验证步骤。CloakBrowser 很快转向容量收费，说明“先证明最新效果，再按生产吞吐收费”比“旧版免费、新版付费”更适合该品类。

## 模式的优势

1. **定价简单**：一个核心指标——活动浏览器会话数；没有复杂的功能矩阵。
2. **免费版不损害品牌**：免费用户看到的是当前产品能力，不是故意变差的指纹质量。
3. **高毛利自托管**：本地订阅不承担浏览器算力和代理成本。
4. **开源社区补充非核心研发**：Humanize、持久化、Docker、跨语言兼容等大量 wrapper 功能可由社区贡献；CloakHQ 集中投入闭源补丁与构建。
5. **续费理由自然**：检测规则与 Chromium 每周变化，持续更新本身就是长期价值。
6. **授权边界清晰地捕获不同价值**：内部自动化、托管云、第三方嵌入分别使用订阅、Cloud、OEM/SaaS 三种收入模型。

## 风险与薄弱点

1. **许可证文案存在冲突（Measured）**：官网和 README FAQ 说最新版本可用免费 key 获得 1 并发；README License 段和 Binary License 1.3 又写最新主版本需要 active paid subscription。即使后台把 free key 视为特殊 entitlement，公开法律文本仍容易让用户无法判断免费权利。
2. **实时会话许可是生产单点（Measured + Inferred）**：二进制会返回“license server unreachable”错误并维护活动会话。wrapper 的 24 小时验证缓存不能完全消除二进制运行时会话服务依赖；大客户会要求离线宽限、SLA 或私有许可服务。
3. **极端数量折扣可能低估支持成本（Inferred）**：Scale 的每并发促销价约为 Solo 的 1/15，但大规模客户的兼容性、滥用审查和支持成本不一定同步下降。
4. **套餐缺少组织能力分层（Measured）**：公开卡片主要只有并发和支持，没有 SSO、组织密钥、审计、策略、LTS 或离线授权；这些只能进入定制 Enterprise，可能造成 Team 到 Enterprise 的产品空档。
5. **“全部功能相同”强化简单性，也削弱升级理由（Inferred）**：如果用户只需要 1 个长期会话，几乎没有付费动力。因此业务增长高度依赖高并发场景和持续支持需求。
6. **Cloud 与本地许可的成本模型不同（Inferred）**：Cloud 由 CloakHQ 承担算力后，单纯按并发定价可能不足，最终需要并发加浏览器小时/流量的独立计量。

## 对 SlyBrowser 的直接建议

### 应复制的结构

1. 保持 **MIT SDK/脚本/测试 + 专有 C++ 浏览器和自编译 WebDriver** 的边界。
2. 免费 Developer 提供当前稳定版本、全部核心指纹能力和 Humanize，但只允许 1 个活动浏览器进程。
3. Starter/Team/Business 主要按 5/20/200 并发扩容；不要按 profile 数或本地浏览器小时收费。
4. 所有层级保持相同的核心浏览器质量；付费差异放在并发、组织管理、发布策略、支持和 SLA，而不是故意降低免费版隐身效果。
5. 单独约定 OEM/SaaS 权利；普通订阅不允许第三方控制浏览器能力。

### 应差异化的部分

1. **用签名短期 lease 降低运行时依赖**：SlyBrowser 可在启动时获得短期签名租约，由浏览器本地验证并在有限宽限期内续租；不要让每个页面动作依赖厂商许可服务器。
2. **自编译 WebDriver 作为默认自动化层**：把浏览器和驱动的一致性作为公开能力，而不是默认依赖 Playwright/CDP，再把 Playwright/Puppeteer保留为显式适配器。
3. **先补齐交付功能再收费**：installer/updater、签名下载、版本 pin/rollback、doctor、会话占用和清晰拒绝原因属于商业系统，不是可延后的辅助功能。
4. **法律文案必须单一事实源**：Free、付费、取消后的版本权利、内部商业使用、OEM/SaaS、离线宽限必须在官网、二进制许可和 README 中完全一致。
5. **不要立即照抄 2,000 并发价格**：先用 5/20 档验证转化和支持成本，200 档销售辅助；Scale 等测得实际利用率、滥用率和支持毛利后再发布。

## 建议的 SlyBrowser 功能分层

| 全部套餐保持一致 | 付费容量/运营能力 | Enterprise/OEM |
| --- | --- | --- |
| 核心 C++ 指纹补丁 | 更高并发 | 离线/air-gapped lease |
| 自编译 WebDriver | 组织密钥与成员管理 | LTS 和固定安全更新窗口 |
| Humanize | 会话仪表盘和审计 | SSO、SLA、部署支持 |
| Geo/代理/持久化 profile | Stable/Preview 策略 | 私有构建或私有许可服务 |
| 签名更新、pin、rollback | 优先支持 | 明确的第三方托管/嵌入权利 |

## 证据来源

- CloakBrowser 官网、功能、价格、Cloud 和 OEM FAQ：<https://cloakbrowser.dev/>
- 官方 README：<https://github.com/CloakHQ/CloakBrowser/blob/main/README.md>
- 官方 Binary License：<https://github.com/CloakHQ/CloakBrowser/blob/main/BINARY-LICENSE.md>
- 本地源码：`E:\dev\CloakBrowser\cloakbrowser\license.py`、`download.py`、`__main__.py`、`CHANGELOG.md`
- SlyBrowser 既有商业研究：`docs/business-model-research-2026-08-15.md`

## Handoff summary

- **Durable facts**：Cloak 当前所有公开套餐使用相同最新浏览器和核心功能；主要按 1/5/20/200/2,000 并发分层；支持在 Business 起升级；Cloud、Enterprise、OEM/SaaS 单独销售。
- **Strategic decision supported**：SlyBrowser 继续采用开放 SDK + 专有二进制 + 并发订阅，并保持核心技术功能跨档一致。
- **Open decisions**：免费 1 并发是否允许长期商业使用；离线宽限；组织功能边界；5/20/200 实际价格；Scale 何时发布。
- **Next action**：在 10–15 个设计伙伴中验证并发需求、免费转付费触发点、许可服务中断容忍度和支持成本。
