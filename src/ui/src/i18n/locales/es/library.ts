import type { library as zh } from "../zh/library";

export const library: typeof zh = {
  title: "Archivos",
  sub: "Imágenes, documentos y otros archivos que la IA creó en el chat principal, todos en un solo lugar",
  back: "← Volver a los archivos",
  shelfGroup: "Filtrar por tipo",
  shelves: { all: "Todos", images: "Imágenes", documents: "Documentos", media: "Audio y vídeo", other: "Otros" },
  openTask: (title: string) => `Abrir la conversación «${title}»`,
  emptyTitle: "Aún no hay archivos",
  emptyBody: "Pide a la IA una hoja de cálculo, un informe o una imagen y los archivos que cree aparecerán aquí solos.",
  shelfEmpty: "Aún no hay archivos de este tipo.",
  loading: "Cargando…",
  loadFailed: "No se pudieron cargar los archivos",
  retry: "Reintentar",
  noMore: "No hay más",
};
