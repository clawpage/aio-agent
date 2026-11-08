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
    step: "Un último paso",
    title: "Cuéntanos sobre ti",
    body: "Los cuatro son opcionales. Con unas pocas palabras, el asistente sabrá cómo llamarte y qué tener en cuenta. Puedes cambiarlos cuando quieras en Configuración → Perfil.",
    name: { label: "¿Cómo quieres que te llamemos?", placeholder: "p. ej.: Sam", hint: "El asistente te llamará así, y es el nombre que ve una clawpage cuando inicias sesión en ella" },
    done: "Listo",
    skip: "Omitir",
  },
};
