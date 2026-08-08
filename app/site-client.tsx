"use client";

import { useEffect, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import type { MemberSession } from "./member-session";
import { ParticleField } from "./particle-field";

type AuthMode = "login";

const authErrors: Record<string, string> = {
  username: "用户名至少需要 3 个字符。",
  password: "密码至少需要 6 个字符。",
  invalid: "用户名或密码不正确。",
  registration_closed: "暂未开放自助注册，请联系平台管理员开通会员账号。",
};

export function SiteClient({
  member,
  initialAuthMode = null,
  initialReturnTo = "/studio",
}: {
  member: MemberSession | null;
  initialAuthMode?: AuthMode | null;
  initialReturnTo?: string;
}) {
  const [authOpen, setAuthOpen] = useState(Boolean(initialAuthMode));
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode ?? "login");
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [returnTo, setReturnTo] = useState(initialReturnTo);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedMode = params.get("auth");
      if (requestedMode === "login" || requestedMode === "register") {
        setAuthMode("login");
        setAuthOpen(true);
      }
      const requestedReturnTo = params.get("return_to");
      if (requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//")) {
        setReturnTo(requestedReturnTo);
      }
      const errorCode = params.get("error");
      if (errorCode) setAuthError(authErrors[errorCode] ?? "登录信息有误，请重新输入。");
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!authOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAuth();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [authOpen]);

  function openAuth(mode: AuthMode = "login") {
    setAuthMode(mode);
    setAuthError("");
    setAuthNotice("");
    setReturnTo("/studio");
    setAuthOpen(true);
  }

  function closeAuth() {
    setAuthOpen(false);
    setAuthError("");
    setAuthNotice("");
    const url = new URL(window.location.href);
    url.searchParams.delete("auth");
    url.searchParams.delete("error");
    url.searchParams.delete("return_to");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function guardStudio(event: MouseEvent<HTMLAnchorElement>) {
    if (member) return;
    event.preventDefault();
    openAuth("login");
  }

  const studioHref = member ? "/studio" : "/?auth=login&return_to=%2Fstudio";

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    event.currentTarget.style.setProperty("--pointer-x", x.toFixed(3));
    event.currentTarget.style.setProperty("--pointer-y", y.toFixed(3));
  }

  return (
    <main className="site-shell home-only" onPointerMove={handlePointerMove}>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="爆点实验室首页">
          <span className="brand-mark"><img src="/media/flash-lab-logo.png" alt="" /></span>
          <span className="brand-name">爆点实验室</span>
          <span className="brand-en">FLASH LAB</span>
        </a>
        <div className="header-actions">
          {member ? (
            <a className="text-link member-link" href="/studio">
              <span className="member-dot" />{member.displayName}
            </a>
          ) : (
            <button className="text-link member-link header-login-button" type="button" onClick={() => openAuth("login")}>
              会员登录
            </button>
          )}
          <a className="header-cta" href={studioHref} onClick={guardStudio}>进入工作台 <span>↗</span></a>
        </div>
      </header>

      <section className="hero" id="top">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="hero-orbit-art" src="/home-orbit-particles.png" alt="" aria-hidden="true" />
        <ParticleField />
        <div className="hero-vignette" aria-hidden="true" />
        <div className="hero-copy">
          <p className="eyebrow"><span /> MERCHANT AI STUDIO</p>
          <h1>
            让每一家好店<br />
            <span className="headline-switch">
              的营销图片持续生长
            </span>
          </h1>
          <p className="hero-lead">
            从商家真实资料出发，让营销图片、短视频与声音资产，在同一套品牌视觉中持续生成。
          </p>
          <div className="hero-actions">
            <a className="primary-cta" href={studioHref} onClick={guardStudio}>开始创作 <span>→</span></a>
          </div>
        </div>

        <div className="orbit-stage" aria-label="AI 创作能力动态展示">
          <a className="orbit-core" href={studioHref} onClick={guardStudio} aria-label="进入 AI 创作引擎">
            <b>AI</b>
            <small>创作引擎</small>
          </a>
          <a className="capability-node node-image" href={studioHref} onClick={guardStudio}><span>01</span><b>图片设计</b></a>
          <a className="capability-node node-video" href={studioHref} onClick={guardStudio}><span>02</span><b>短视频推广</b></a>
          <a className="capability-node node-assets" href={studioHref} onClick={guardStudio}><span>03</span><b>素材资产</b></a>
          <div className="generation-status"><span /> AI ENGINE ONLINE</div>
        </div>
      </section>

      <footer className="home-footer">
        <a
          className="icp-link"
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noreferrer"
        >
          备案号：鄂ICP备2026017649号-1
        </a>
      </footer>

      {authOpen && !member ? (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeAuth();
        }}>
          <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className="auth-close" type="button" aria-label="关闭登录弹窗" onClick={closeAuth}>×</button>
            <div className="auth-brand">
              <span className="brand-mark"><img src="/media/flash-lab-logo.png" alt="" /></span>
              <div><b>爆点实验室</b><small>FLASH LAB</small></div>
            </div>

            <div className="auth-heading">
              <small>WELCOME BACK</small>
              <h2 id="auth-title">登录会员账号</h2>
              <p>登录后继续管理创作内容与商家资产。</p>
            </div>

            <form className="auth-form" action="/api/auth/account" method="post">
              <input type="hidden" name="mode" value="login" />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label>
                <span>用户名</span>
                <input name="username" type="text" autoComplete="username" placeholder="请输入用户名" minLength={3} required autoFocus />
              </label>
              <label>
                <span>密码</span>
                <span className="password-field">
                  <input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="请输入登录密码" minLength={6} required />
                  <button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隐藏" : "显示"}</button>
                </span>
              </label>

              {authError ? <p className="auth-message is-error" role="alert">{authError}</p> : null}
              {authNotice ? <p className="auth-message" role="status">{authNotice}</p> : null}

              <div className="auth-options">
                <label className="auth-check"><input type="checkbox" name="remember" defaultChecked /> <span>30 天内保持登录</span></label>
                <button type="button" onClick={() => setAuthNotice("请联系平台管理员重置登录密码。")}>忘记密码？</button>
              </div>

              <button className="auth-submit" type="submit">登录并进入工作台<span>→</span></button>
            </form>

            <p className="auth-demo-tip">暂未开放自助注册。新会员账号由平台管理员统一创建。</p>
          </section>
        </div>
      ) : null}
    </main>
  );
}
