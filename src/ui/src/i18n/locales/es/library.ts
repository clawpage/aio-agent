import type { library as zh } from "../zh/library";

export const library: typeof zh = {
  title: "Archivos",
  sub: "Imágenes, documentos y otros archivos del chat principal, todos en un solo lugar",
  back: "← Volver a los archivos",
  shelfGroup: "Filtrar por tipo",
  shelves: { all: "Todos", images: "Imágenes", documents: "Documentos", media: "Audio y vídeo", other: "Otros" },
  fromYou: "Enviado por ti",
  fromAi: "Respuesta de la IA",
  openTask: (title: string) => `Abrir la conversación «${title}»`,
  emptyTitle: "Aún no hay archivos",
  emptyBody: "Envía imágenes o documentos en el chat principal, o pide a la IA una hoja de cálculo, un informe o una imagen. Los archivos aparecerán aquí solos.",
  shelfEmpty: "Aún no hay archivos de este tipo.",
  loading: "Cargando…",
  loadFailed: "No se pudieron cargar los archivos",
  retry: "Reintentar",
  noMore: "No hay más",
};
