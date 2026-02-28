/**
 * delete-event.js — Ferramenta MCP para deletar compromissos do Calendário
 *
 * Busca o evento pelo título (e opcionalmente data) e solicita confirmação antes de deletar.
 */

import { z } from "zod";
import { graphRequest, graphRequestPaginated } from "../graph.js";

export const deleteEventSchema = z.object({
  titulo_busca: z
    .string()
    .min(1, "Título de busca não pode ser vazio")
    .describe("Título (ou parte do título) do compromisso a ser deletado. Usado para localizar o evento."),
  data_busca: z
    .string()
    .optional()
    .describe("Data do compromisso no formato ISO 8601 (ex: 2026-03-10). Ajuda a encontrar o evento correto quando há múltiplos com título semelhante. Padrão: hoje."),
  confirmacao: z
    .boolean()
    .optional()
    .default(false)
    .describe("Obrigatório true para confirmar a exclusão. Na primeira chamada, deixe false para ver qual evento será deletado antes de confirmar."),
});

export async function deleteEvent(params) {
  const { titulo_busca, data_busca, confirmacao } = params;

  // 1. Buscar o evento pelo título
  const offset = "-03:00";
  const fuso = "America/Sao_Paulo";
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: fuso });
  const dataBusca = data_busca ?? hoje;

  const startISO = new Date(`${dataBusca}T00:00:00${offset}`).toISOString();
  const endISO = new Date(`${dataBusca}T23:59:59${offset}`).toISOString();

  const endpoint = `/me/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$top=500&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,isAllDay`;
  const result = await graphRequestPaginated(endpoint, 500);

  if (!result?.value?.length) {
    return `Nenhum compromisso encontrado para a data ${dataBusca}.`;
  }

  // 2. Filtrar por título (case insensitive, partial match)
  const termoBusca = titulo_busca.toLowerCase();
  const matches = result.value.filter((ev) =>
    (ev.subject || "").toLowerCase().includes(termoBusca)
  );

  if (matches.length === 0) {
    const disponiveis = result.value.map((ev) => `"${ev.subject}"`).join(", ");
    return `Nenhum compromisso encontrado com o título "${titulo_busca}" em ${dataBusca}.\nCompromissos do dia: ${disponiveis}`;
  }

  if (matches.length > 1) {
    const lista = matches
      .map((ev) => {
        const hora = ev.isAllDay ? "dia inteiro" : (ev.start.dateTime || "").substring(11, 16);
        return `"${ev.subject}" (${hora})`;
      })
      .join(", ");
    return `Encontrados ${matches.length} compromissos com "${titulo_busca}": ${lista}\nInforme uma data mais específica ou um título mais preciso.`;
  }

  const evento = matches[0];

  // 3. Se não confirmado, mostrar preview e pedir confirmação
  if (!confirmacao) {
    const hora = evento.isAllDay
      ? "Dia inteiro"
      : `${(evento.start.dateTime || "").substring(11, 16)} – ${(evento.end.dateTime || "").substring(11, 16)}`;
    const local = evento.location?.displayName ? `\n   Local: ${evento.location.displayName}` : "";
    const organizador = evento.organizer?.emailAddress?.name || evento.organizer?.emailAddress?.address || "";
    const orgStr = organizador ? `\n   Organizador: ${organizador}` : "";

    return (
      `⚠️ Compromisso encontrado — confirme a exclusão:\n` +
      `   Título: ${evento.subject || "(sem título)"}\n` +
      `   Data: ${dataBusca}\n` +
      `   Horário: ${hora}${local}${orgStr}\n\n` +
      `Para deletar, chame novamente com confirmacao: true`
    );
  }

  // 4. Deletar o evento
  await graphRequest("DELETE", `/me/events/${evento.id}`);

  const hora = evento.isAllDay
    ? "dia inteiro"
    : `${(evento.start.dateTime || "").substring(11, 16)} – ${(evento.end.dateTime || "").substring(11, 16)}`;

  return `Compromisso deletado com sucesso!\n- Título: ${evento.subject || "(sem título)"}\n- Data: ${dataBusca}\n- Horário: ${hora}`;
}
