import type { profile as zh } from "../zh/profile";

export const profile: typeof zh = {
  title: "Profile",
  intro: "Everything is optional. The assistant looks these up in your knowledge base when it needs them instead of carrying them everywhere; clawpages only see your nickname.",
  fields: {
    nickname: { label: "Nickname", placeholder: "e.g. Sam", hint: "The name a clawpage sees when you sign in to it" },
    preferredName: { label: "What should we call you?", placeholder: "e.g. Dr. Lee" },
    location: { label: "Location or time zone", placeholder: (zone: string) => `e.g. ${zone}` },
    language: { label: "Languages", placeholder: "e.g. English, 中文" },
    occupation: { label: "Occupation or role", placeholder: "e.g. product manager, student" },
    interests: { label: "Interests", placeholder: "e.g. photography, hiking, cooking" },
    notes: { label: "Things the assistant should keep in mind", placeholder: "e.g. keep answers short; compare prices before buying; no alcohol suggestions" },
  },
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  failed: "Couldn't save. Please try again.",
  loadFailed: "Couldn't load your profile. Please try again.",
  retry: "Retry",
  onboarding: {
    step: "One last step",
    title: "Tell us about yourself",
    body: "All four are optional. A few words tell the assistant what to call you and what to keep in mind. You can change them anytime in Settings → Profile.",
    name: { label: "What should we call you?", placeholder: "e.g. Sam", hint: "The assistant calls you this, and it's the name a clawpage sees when you sign in to it" },
    done: "Done",
    skip: "Skip",
  },
};
