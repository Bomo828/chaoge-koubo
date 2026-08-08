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
  const [authOpen, setAuthOpen] = useState(Boolean(initialAuthMode));
  const [authError, setAuthError] = useState("");
  const [returnTo, setReturnTo] = useState(initialReturnTo);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedReturnTo = params.get("return_to");
      if (requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//")) {
        setReturnTo(requestedReturnTo);
      }
      const errorCode = params.get("error");
      if (errorCode) {
        setAuthError(authErrors[errorCode] ?? "登录信息有误，请重新输入。");
        setAuthOpen(true);
      }
      if (initialAuthMode || errorCode) {
        usernameRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialAuthMode]);

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

  function openAuth() {
    setAuthError("");
    setReturnTo("/studio");
    setAuthOpen(true);
    window.setTimeout(() => usernameRef.current?.focus({ preventScroll: true }), 80);
  }

  function closeAuth() {
    setAuthOpen(false);
    setAuthError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("auth");
    url.searchParams.delete("error");
    url.searchParams.delete("return_to");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function guardStudio(event: MouseEvent<HTMLAnchorElement>) {
    if (member) return;
    event.preventDefault();
    openAuth();
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
          <span className="launch-wordmark"><b>爆点实验室</b></span>
        </a>

        <div className="launch-header-actions">
          <a className="launch-enter" href={studioHref} onClick={guardStudio}>
            <b>{member ? "工作台" : "登录"}</b>
            <span>↗</span>
          </a>
        </div>
      </header>

      <section className="launch-stage" id="top">
        <section className="launch-copy">
          <h1 className="launch-title-image">
            <img src="/media/flash-lab-title-lockup.png" alt="爆点实验室，把灵感，放大到屏幕之外" />
          </h1>
        </section>
      </section>

      <a className="launch-record" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">鄂ICP备2026017649号-1</a>

      {authOpen && !member ? (
        <div className="launch-auth-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeAuth();
        }}>
          <section className="launch-login-card launch-auth-modal" role="dialog" aria-modal="true" aria-labelledby="launch-auth-title">
            <button className="launch-auth-close" type="button" aria-label="关闭登录窗口" onClick={closeAuth}>×</button>
            <div className="launch-login-brand">
              <span><img src="/media/flash-lab-logo.png" alt="" /></span>
              <h2 id="launch-auth-title">登录</h2>
            </div>

            <form className="launch-login-form" action="/api/auth/account" method="post">
              <input type="hidden" name="mode" value="login" />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label>
                <span>用户名</span>
                <input ref={usernameRef} name="username" type="text" autoComplete="username" placeholder="请输入用户名" minLength={3} required />
              </label>
              <label>
                <span>密码</span>
                <span className="launch-password-field">
                  <input name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="请输入密码" minLength={6} required />
                  <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隐藏" : "显示"}</button>
                </span>
              </label>

              {authError ? <p className="launch-auth-message is-error" role="alert">{authError}</p> : null}

              <button className="launch-submit" type="submit"><span>进入工作台</span><b>↗</b></button>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
