import type { profile as zh } from "../zh/profile";

export const profile: typeof zh = {
  title: "Perfil",
  intro: "Todo es opcional. El asistente lo consulta en tu base de conocimiento cuando lo necesita, en lugar de llevarlo siempre consigo; las clawpages solo ven tu apodo.",
  fields: {
    nickname: { label: "Apodo", placeholder: "p. ej.: Sam", hint: "El nombre que ve una clawpage cuando inicias sesión en ella" },
    preferredName: { label: "¿Cómo quieres que te llamemos?", placeholder: "p. ej.: Dra. López" },
    location: { label: "Ubicación o zona horaria", placeholder: (zone: string) => `p. ej.: ${zone}` },
    language: { label: "Idiomas", placeholder: "p. ej.: español, English" },
    occupation: { label: "Ocupación o rol", placeholder: "p. ej.: gerente de producto, estudiante" },
    interests: { label: "Intereses", placeholder: "p. ej.: fotografía, senderismo, cocina" },
    notes: { label: "Lo que el asistente debe tener en cuenta", placeholder: "p. ej.: respuestas breves; comparar precios antes de comprar; nada de alcohol" },
  },
  save: "Guardar",
  saving: "Guardando…",
  saved: "Guardado",
  failed: "No se pudo guardar. Inténtalo de nuevo.",
  loadFailed: "No se pudo cargar tu perfil. Inténtalo de nuevo.",
  retry: "Reintentar",
  onboarding: {
    title: "Cuéntanos sobre ti",
    body: "Unos datos básicos ayudan al asistente a entenderte. Puedes omitir cualquiera y cambiarlos cuando quieras en Configuración → Perfil.",
    done: "Listo",
    skip: "Omitir",
  },
};
