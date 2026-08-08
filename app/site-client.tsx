"use client";

import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import type { MemberSession } from "./member-session";

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
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [returnTo, setReturnTo] = useState(initialReturnTo);
  const usernameRef = useRef<HTMLInputElement>(null);
  const loginPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedReturnTo = params.get("return_to");
      if (requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//")) {
        setReturnTo(requestedReturnTo);
      }
      const errorCode = params.get("error");
      if (errorCode) setAuthError(authErrors[errorCode] ?? "登录信息有误，请重新输入。");
      if (initialAuthMode || errorCode) {
        loginPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        usernameRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialAuthMode]);

  function focusLogin() {
    setAuthError("");
    setAuthNotice("");
    setReturnTo("/studio");
    loginPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => usernameRef.current?.focus({ preventScroll: true }), 420);
  }

  function guardStudio(event: MouseEvent<HTMLAnchorElement>) {
    if (member) return;
    event.preventDefault();
    focusLogin();
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    event.currentTarget.style.setProperty("--launch-x", x.toFixed(3));
    event.currentTarget.style.setProperty("--launch-y", y.toFixed(3));
  }

  const studioHref = member ? "/studio" : "/?auth=login&return_to=%2Fstudio";

  return (
    <main className="launch-home" onPointerMove={handlePointerMove}>
      <video
        className="launch-video"
        src="/media/flash-lab-hero-20260808.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
      />
      <div className="launch-color-wash" aria-hidden="true" />
      <div className="launch-grid" aria-hidden="true" />
      <div className="launch-noise" aria-hidden="true" />

      <header className="launch-header">
        <a className="launch-brand" href="#top" aria-label="爆点实验室首页">
          <span className="launch-logo"><img src="/media/flash-lab-logo.png" alt="" /></span>
          <span><b>爆点实验室</b><small>FLASH LAB</small></span>
        </a>

        <div className="launch-system"><i /> SYSTEM ONLINE <span>08 / 08</span></div>

        <div className="launch-header-actions">
          {member ? (
            <a className="launch-member" href="/studio"><i />{member.displayName}</a>
          ) : (
            <button className="launch-login-link" type="button" onClick={focusLogin}>会员登录</button>
          )}
          <a className="launch-enter" href={studioHref} onClick={guardStudio}>进入工作台 <span>↗</span></a>
        </div>
      </header>

      <section className="launch-stage" id="top">
        <section className={`launch-login-card${member ? " is-member" : ""}`} ref={loginPanelRef} aria-label={member ? "会员入口" : "会员登录"}>
          <div className="launch-window-bar">
            <span><i /><i /><i /></span>
            <b>{member ? "MEMBER_PORTAL" : "AUTH_PORTAL"} // 01</b>
          </div>

          {member ? (
            <div className="launch-member-panel">
              <small>SESSION ACTIVE</small>
              <div className="launch-avatar">{member.displayName.slice(0, 1)}</div>
              <h2>{member.displayName}</h2>
              <p>{member.level} · 当前积分 {member.points.toLocaleString()}</p>
              <a href="/studio">继续创作 <span>→</span></a>
            </div>
          ) : (
            <>
              <div className="launch-login-heading">
                <small>WELCOME BACK, CREATOR</small>
                <h2>登录，点燃创作</h2>
                <p>进入你的 AI 图片、视频与声音工作台。</p>
              </div>

              <form className="launch-login-form" action="/api/auth/account" method="post">
                <input type="hidden" name="mode" value="login" />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label>
                  <span>01 / 用户名</span>
                  <input ref={usernameRef} name="username" type="text" autoComplete="username" placeholder="输入会员用户名" minLength={3} required />
                </label>
                <label>
                  <span>02 / 登录密码</span>
                  <span className="launch-password-field">
                    <input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="输入登录密码" minLength={6} required />
                    <button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隐藏" : "显示"}</button>
                  </span>
                </label>

                {authError ? <p className="launch-auth-message is-error" role="alert">{authError}</p> : null}
                {authNotice ? <p className="launch-auth-message" role="status">{authNotice}</p> : null}

                <div className="launch-login-options">
                  <label><input type="checkbox" name="remember" defaultChecked /><span>保持登录状态</span></label>
                  <button type="button" onClick={() => setAuthNotice("请联系平台管理员重置登录密码。")}>忘记密码？</button>
                </div>

                <button className="launch-submit" type="submit"><span>进入创作舱</span><b>→</b></button>
              </form>

              <p className="launch-account-note"><i /> 会员账号由平台管理员统一创建</p>
            </>
          )}
        </section>

        <section className="launch-copy">
          <p className="launch-eyebrow"><span>CREATE</span> WITHOUT LIMITS</p>
          <h1>把灵感<br />放大到<br /><em>屏幕之外</em></h1>
          <p className="launch-lead">一张图、一段口播、一个突然冒出的想法——在这里，把它变成真正会被看见的作品。</p>
          <div className="launch-capabilities" aria-label="平台能力">
            <span><b>01</b> AI 图片</span>
            <span><b>02</b> 动态视频</span>
            <span><b>03</b> 声音克隆</span>
          </div>
          <a className="launch-copy-cta" href={studioHref} onClick={guardStudio}>{member ? "继续你的创作" : "从登录开始"}<span>↗</span></a>
        </section>

        <div className="launch-space-label" aria-hidden="true">
          <span>DEEP SPACE / CREATIVE MODE</span>
          <b>∞</b>
        </div>
      </section>

      <footer className="launch-footer">
        <span>AI IMAGE · VIDEO · VOICE · ASSET</span>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">鄂ICP备2026017649号-1</a>
        <span>© 2026 FLASH LAB</span>
      </footer>
    </main>
  );
}
