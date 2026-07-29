---
layout: home

hero:
  name: PiDeck for NeoNisch
  text: 给 NN 的桌面工作台
  tagline: 让 pi、NeoNisch 与长期协作，安静地待在同一个工作区里。
  image:
    src: /neonisch-logo.svg
    alt: NeoNisch mark
  actions:
    - theme: brand
      text: 查看源码
      link: https://github.com/Soenchin/PiDeck-for-Neo
    - theme: alt
      text: 开发与运行
      link: /guide/getting-started

features:
  - title: 为 NN 而生
    details: 不是泛用的 PiDeck 发布版，而是围绕 Soen 与 NeoNisch 长期协作持续打磨的分支。
  - title: 会话保持连续
    details: 多 Agent、历史恢复、压缩后的上下文、缓存诊断和后台状态，都服务于长时间工作。
  - title: 保持工作感
    details: 少一点营销式装饰，多一点桌面工具的安静、清晰和可控。
---

<section class="neo-hero-note" aria-label="NeoNisch introduction">
  <div class="neo-hero-note__eyebrow">NEONISCH / PI AGENT WORKSPACE</div>
  <p>
    这是 Soen 与 NeoNisch 一起使用的 PiDeck。它保留 pi 原生的 Agent、工具和会话能力，
    把桌面协作、品牌体验、双 Agent 房间、桌宠和长期会话管理收进一个熟悉的工作台。
  </p>
  <div class="neo-hero-note__meta">
    <span><i class="status-dot" aria-hidden="true"></i> NN-focused fork</span>
    <span>AGPL-3.0-only</span>
    <span>Windows / macOS / Linux</span>
  </div>
</section>

<section class="neo-showcase" aria-labelledby="showcase-title">
  <div class="section-kicker">THE WORKSPACE</div>
  <div class="section-heading">
    <h2 id="showcase-title">工作不是从空白页开始的。</h2>
    <p>项目、Agent、历史、Git 和下一步要做的事，都在同一张桌面上。</p>
  </div>
  <figure class="neo-showcase__figure">
    <img
      src="/images/neonisch-overview.png"
      alt="NeoNisch workspace with project sidebar, collaboration entry point, and Git file panel"
      width="2047"
      height="1151"
    />
    <figcaption>NeoNisch workspace · a quiet place for long-running collaboration.</figcaption>
  </figure>
</section>

<section class="neo-grid" aria-label="Branch highlights">
  <article class="neo-card neo-card--wide">
    <div class="neo-card__index">01 / CONTINUITY</div>
    <h2>把上下文留在场上。</h2>
    <p>压缩后的历史、缓存诊断、会话摘要标题、未读状态和跨会话小问题，减少长任务中最烦人的断点。</p>
    <span class="neo-card__code">session / history / cache / ask</span>
  </article>
  <article class="neo-card">
    <div class="neo-card__index">02 / ROOM</div>
    <h2>Neo 与 ROCKET。</h2>
    <p>双 Agent 房间，为不同角色和任务视角保留清晰的空间。</p>
    <span class="neo-card__code">neo + rocket</span>
  </article>
  <article class="neo-card">
    <div class="neo-card__index">03 / PRESENCE</div>
    <h2>桌宠也在工作区里。</h2>
    <p>NeoNisch 的桌宠、启动体验和品牌视觉，不是外挂，而是 NN 工作流的一部分。</p>
    <span class="neo-card__code">pet / motion / identity</span>
  </article>
</section>

<section class="neo-cta" aria-labelledby="cta-title">
  <div>
    <div class="section-kicker">OPEN SOURCE / OWN WORKFLOW</div>
    <h2 id="cta-title">这是一个给 NN 用的工具。</h2>
    <p>如果你也在用 pi 做长期本地开发，可以从源码开始，按自己的工作方式继续改。</p>
  </div>
  <div class="neo-cta__actions">
    <a class="neo-button neo-button--brand" href="https://github.com/SoenChin/PiDeck-for-Neo">GitHub 仓库</a>
    <a class="neo-button neo-button--quiet" href="/guide/getting-started">开始使用 <span aria-hidden="true">↗</span></a>
  </div>
</section>

<div class="neo-footer-note">
  <span>PiDeck for NeoNisch</span>
  <span>Built for the long run.</span>
</div>
