"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import type { MemberSession } from "./member-session";
import { publicMediaCdnEnabled, publicMediaUrl } from "../lib/public-media";

type AuthMode = "login" | "register";

const authErrors: Record<string, string> = {
  username: "用户名至少需要 3 个字符。",
  password: "密码至少需要 6 个字符。",
  invalid: "用户名或密码不正确。",
  invite_required: "请输入平台发放的邀请码。",
  invite_invalid: "邀请码无效或已被管理员停用。",
  invite_expired: "邀请码已过期，请联系平台获取新邀请码。",
  invite_used: "邀请码可用次数已经用完。",
  username_taken: "这个用户名已经被使用，请更换。",
  display_name: "请填写不超过 40 个字符的会员昵称。",
  password_strength: "密码需要 8–72 个字符，并同时包含字母和数字。",
  password_mismatch: "两次输入的密码不一致。",
  rate_limited: "尝试次数过多，请 15 分钟后再试。",
  registration_failed: "注册暂时失败，请稍后重试。",
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
  const [authMode, setAuthMode] = useState<AuthMode>(initialAuthMode || "login");
  const [authOpen, setAuthOpen] = useState(Boolean(initialAuthMode));
  const [authError, setAuthError] = useState("");
  const [returnTo, setReturnTo] = useState(initialReturnTo);
  const [resolvedMember, setResolvedMember] = useState(member);
  const [sessionResolved, setSessionResolved] = useState(Boolean(member));
  const [heroReady, setHeroReady] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedReturnTo = params.get("return_to");
      if (requestedReturnTo?.startsWith("/") && !requestedReturnTo.startsWith("//")) {
        setReturnTo(requestedReturnTo);
      }
      const errorCode = params.get("error");
      const requestedMode = params.get("auth");
      if (requestedMode === "register" || requestedMode === "login") {
        setAuthMode(requestedMode);
        setAuthOpen(true);
      }
      if (errorCode) {
        setAuthError(authErrors[errorCode] ?? "登录信息有误，请重新输入。");
        setAuthOpen(true);
      }
      if (requestedMode === "register" || requestedMode === "login" || initialAuthMode || errorCode) {
        usernameRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialAuthMode]);

  useEffect(() => {
    if (member) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch("/api/auth/session", { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("session unavailable")))
        .then((data: { member?: MemberSession | null }) => setResolvedMember(data.member ?? null))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) setResolvedMember(null);
        })
        .finally(() => setSessionResolved(true));
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [member]);

  useEffect(() => {
    let timer = 0;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => setHeroReady(true), 120);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
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
    if (resolvedMember || !sessionResolved) return;
    event.preventDefault();
    openAuth("login");
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    event.currentTarget.style.setProperty("--launch-x", x.toFixed(3));
    event.currentTarget.style.setProperty("--launch-y", y.toFixed(3));
  }

  const studioHref = "/studio";

  return (
    <main className="launch-home" onPointerMove={handlePointerMove}>
      <video
        className="launch-video"
        src={heroReady ? publicMediaUrl("/media/flash-lab-hero-20260808.mp4") : undefined}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        poster={publicMediaUrl("/media/flash-lab-hero-poster.jpg")}
        disablePictureInPicture
        aria-hidden="true"
      />
      <div className="launch-color-wash" aria-hidden="true" />
      <div className="launch-grid" aria-hidden="true" />
      <div className="launch-noise" aria-hidden="true" />

      <header className="launch-header">
        <a className="launch-brand" href="#top" aria-label="爆点实验室首页">
          <span className="launch-logo"><Image src={publicMediaUrl("/media/flash-lab-logo.png")} width={512} height={512} sizes="52px" alt="" priority unoptimized={publicMediaCdnEnabled} /></span>
          <span className="launch-wordmark"><b>爆点实验室</b></span>
        </a>

        <div className="launch-header-actions">
          <a className="launch-enter" href={studioHref} onClick={guardStudio}>
            <b>{resolvedMember ? "工作台" : sessionResolved ? "登录" : "进入工作台"}</b>
            <span>↗</span>
          </a>
        </div>
      </header>

      <section className="launch-stage" id="top">
        <section className="launch-copy">
          <h1 className="launch-title-image">
            <Image src={publicMediaUrl("/media/flash-lab-title-lockup.png")} width={1686} height={933} sizes="(max-width: 720px) 86vw, 680px" quality={86} alt="爆点实验室，把灵感，放大到屏幕之外" priority unoptimized={publicMediaCdnEnabled} />
          </h1>
        </section>
      </section>

      <a className="launch-record" href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">鄂ICP备2026017649号-1</a>

      {authOpen && !resolvedMember ? (
        <div className="launch-auth-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeAuth();
        }}>
          <section className="launch-login-card launch-auth-modal" role="dialog" aria-modal="true" aria-labelledby="launch-auth-title">
            <button className="launch-auth-close" type="button" aria-label="关闭登录窗口" onClick={closeAuth}>×</button>
            <div className="launch-login-brand">
              <span><Image src={publicMediaUrl("/media/flash-lab-logo.png")} width={512} height={512} sizes="56px" alt="" unoptimized={publicMediaCdnEnabled} /></span>
              <h2 id="launch-auth-title">{authMode === "login" ? "登录" : "邀请注册"}</h2>
            </div>

            <form className="launch-login-form" action="/api/auth/account" method="post">
              <div className="launch-auth-tabs" role="tablist" aria-label="会员入口">
                <button type="button" className={authMode === "login" ? "is-active" : ""} onClick={() => { setAuthMode("login"); setAuthError(""); }}>登录</button>
                <button type="button" className={authMode === "register" ? "is-active" : ""} onClick={() => { setAuthMode("register"); setAuthError(""); }}>邀请码注册</button>
              </div>
              <input type="hidden" name="mode" value={authMode} />
              <input type="hidden" name="returnTo" value={returnTo} />
              {authMode === "register" ? <label>
                <span>邀请码</span>
                <input name="invitationCode" type="text" autoComplete="off" placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={24} required />
              </label> : null}
              <label>
                <span>用户名</span>
                <input ref={usernameRef} name="username" type="text" autoComplete="username" placeholder="请输入用户名" minLength={3} required />
              </label>
              {authMode === "register" ? <label>
                <span>昵称</span>
                <input name="displayName" type="text" autoComplete="name" placeholder="请输入会员昵称" maxLength={40} required />
              </label> : null}
              <label>
                <span>密码</span>
                <span className="launch-password-field">
                  <input name="password" type={showPassword ? "text" : "password"} autoComplete={authMode === "login" ? "current-password" : "new-password"} placeholder={authMode === "login" ? "请输入密码" : "至少 8 位，包含字母和数字"} minLength={authMode === "login" ? 6 : 8} required />
                  <button type="button" aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? "隐藏" : "显示"}</button>
                </span>
              </label>
              {authMode === "register" ? <label>
                <span>确认密码</span>
                <span className="launch-password-field">
                  <input name="confirmPassword" type={showPassword ? "text" : "password"} autoComplete="new-password" placeholder="再次输入密码" minLength={8} required />
                </span>
              </label> : null}

              {authError ? <p className="launch-auth-message is-error" role="alert">{authError}</p> : null}

              <button className="launch-submit" type="submit"><span>{authMode === "login" ? "进入工作台" : "注册并进入工作台"}</span><b>↗</b></button>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}
