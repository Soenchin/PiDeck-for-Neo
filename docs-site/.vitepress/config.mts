import { defineConfig } from "vitepress";

const base = process.env.VITEPRESS_BASE ?? "/PiDeck-for-Neo/";
const siteUrl = "https://soenchin.github.io/PiDeck-for-Neo/";
const repositoryUrl = "https://github.com/Soenchin/PiDeck-for-Neo";
const releasesUrl = `${repositoryUrl}/releases`;

export default defineConfig({
  title: "PiDeck for NeoNisch",
  description:
    "PiDeck for NeoNisch is a focused desktop workspace for the long-term collaboration between Soen and NeoNisch.",
  lang: "zh-CN",
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: `${base}neonisch-logo.svg` }],
    ["link", { rel: "canonical", href: siteUrl }],
    [
      "meta",
      {
        name: "keywords",
        content:
          "NeoNisch, PiDeck for NeoNisch, pi-agent, AI coding workspace, desktop agent, Neo, ROCKET",
      },
    ],
    ["meta", { name: "author", content: "SoenChin" }],
    ["meta", { name: "robots", content: "index, follow" }],
    ["meta", { property: "og:site_name", content: "PiDeck for NeoNisch" }],
    [
      "meta",
      {
        property: "og:title",
        content: "PiDeck for NeoNisch — A workspace for NN collaboration",
      },
    ],
    [
      "meta",
      {
        property: "og:description",
        content:
          "A quiet, focused desktop workspace where pi, NeoNisch, and long-running agent collaboration meet.",
      },
    ],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:url", content: siteUrl }],
    ["meta", { property: "og:image", content: `${siteUrl}images/neonisch-overview.png` }],
    ["meta", { property: "og:image:width", content: "2047" }],
    ["meta", { property: "og:image:height", content: "1151" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "PiDeck for NeoNisch" }],
    [
      "meta",
      {
        name: "twitter:description",
        content: "The NeoNisch-focused PiDeck workspace for long-term agent collaboration.",
      },
    ],
    ["meta", { name: "twitter:image", content: `${siteUrl}images/neonisch-overview.png` }],
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "PiDeck for NeoNisch",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Windows, macOS, Linux",
        description:
          "A NeoNisch-focused desktop workspace for long-term collaboration with pi agents.",
        url: siteUrl,
        downloadUrl: releasesUrl,
        sourceCodeRepository: repositoryUrl,
        license: "https://www.gnu.org/licenses/agpl-3.0.html",
        author: {
          "@type": "Person",
          name: "SoenChin",
          url: "https://github.com/Soenchin",
        },
      }),
    ],
  ],
  themeConfig: {
    logo: "/neonisch-logo.svg",
    siteTitle: "PiDeck for NeoNisch",
    nav: [
      { text: "首页", link: "/" },
      { text: "English", link: "/en" },
      { text: "使用指南", link: "/guide/usage-guide" },
      { text: "开发", link: "/guide/development" },
      { text: "GitHub", link: repositoryUrl },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "PiDeck for NeoNisch",
          items: [
            { text: "使用指南", link: "/guide/usage-guide" },
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "设置与技能", link: "/guide/settings" },
            { text: "常见问题", link: "/guide/faq" },
            { text: "开发与打包", link: "/guide/development" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: repositoryUrl }],
    search: { provider: "local" },
    outline: { label: "本页目录", level: [2, 3] },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdated: {
      text: "最近更新",
      formatOptions: { dateStyle: "medium", timeStyle: "short" },
    },
    editLink: {
      pattern: `${repositoryUrl}/edit/main/docs-site/:path`,
      text: "在 GitHub 上编辑此页",
    },
    footer: {
      message: "Released under the AGPL-3.0-only License.",
      copyright: "Copyright © 2026 SoenChin",
    },
  },
});
