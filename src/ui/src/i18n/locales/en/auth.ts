import type { auth as zh } from "../zh/auth";

export const auth: typeof zh = {
  sessionExpired: "Your session has expired. Please log in again.",
  restoring: "Restoring your session…",
  brand: "AIO Agent",
  intro: {
    login: "Everything you need, all in one stop. Log in with your account.",
    register: "Everything you need, all in one stop. Sign up with an invite code.",
  },
  fields: {
    username: "Username",
    usernameHint: "2–40 lowercase letters, digits, - or _",
    password: "Password",
    passwordHint: "Enter your password",
    newPasswordHint: "At least 12 characters",
    confirm: "Confirm password",
    confirmHint: "Enter the password again",
    inviteCode: "Invite code",
  },
  passwordMismatch: "The passwords don't match",
  google: {
    button: "Sign in / sign up with Google",
    inviteIntro: "Signed in with Google. An invite code is required for your first visit.",
    waiting: "Finish signing in with Google in your browser, then return to the app.",
    failed: "Google sign-in wasn't completed or has expired. Please try again.",
    activate: "Verify invite and continue",
    activating: "Verifying…",
    cancel: "Use another sign-in method",
    retry: "Try Google sign-in again",
  },
  invite: {
    askBefore: "No invite code yet? Email ",
    askAfter: " to request one. Each code can register one account.",
    mailSubject: "AIO Agent invite code request",
    askAdmin: "Ask your administrator for an invite code. Each code can register one account.",
  },
  sessionUnverified: "Can't verify your session right now. We'll retry once you're back online.",
  submit: {
    register: "Sign up and log in",
    registering: "Signing up…",
    login: "Log in",
    loggingIn: "Logging in…",
  },
  switch: {
    haveAccount: "Already have an account? ",
    noAccount: "Don't have an account? ",
    toLogin: "Log in",
    toRegister: "Sign up with an invite code",
  },
  foreign: {
    title: (owner: string) => `This page belongs to ${owner}`,
    body: (current: string) => `You're logged in as ${current}. A browser can be logged in to one account at a time.`,
    switchTo: (owner: string) => `Log out and log in as ${owner}`,
    backHome: "Back to my page",
  },
};
