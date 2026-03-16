/**
 * check-availability.js — Ferramenta MCP para verificar disponibilidade de pessoas
 * Usa o endpoint /me/calendar/getSchedule da Microsoft Graph API.
 * Respeita o nível de compartilhamento de cada pessoa:
 *   - Compartilhamento só de disponibilidade → retorna blocos "busy" sem título
 *   - Compartilhamento com nome → retorna título dos eventos também
 */

import { z } from "zod";
import { graphRequest } from "../graph.js";

export const checkAvailabilitySchema = z.object({
  pessoas: z
    .string()
    .describe(
      "E-mails das pessoas separados por vírgula. Ex: joao@empresa.com, maria@empresa.com"
    ),
  data_inicio: z
    .string()
    .describe(
      "Data e hora de início da janela de consulta no formato ISO 8601. Ex: 2026-03-10T08:00:00"
    ),
  data_fim: z
    .string()
    .describe(
      "Data e hora de fim da janela de consulta no formato ISO 8601. Ex: 2026-03-10T18:00:00 (máximo 62 dias a partir de data_inicio)"
    ),
  intervalo_minutos: z
    .number()
    .optional()
    .default(15)
    .describe(
      "Granularidade em minutos para identificar janelas livres. Padrão: 15"
    ),
  fuso_horario: z
    .string()
    .optional()
    .default("America/Sao_Paulo")
    .describe("Fuso horário da consulta. Padrão: America/Sao_Paulo"),
});

export async function checkAvailability(params) {
  const { pessoas, data_inicio, data_fim, intervalo_minutos, fuso_horario } = params;

  const emails = pessoas.split(",").map((e) => e.trim()).filter(Boolean);

  if (emails.length === 0) {
    throw new Error("Informe pelo menos um e-mail no campo 'pessoas'.");
  }

  // Validar período máximo de 62 dias (limite da Graph API)
  const diasDiferenca = (new Date(data_fim) - new Date(data_inicio)) / (1000 * 60 * 60 * 24);
  if (diasDiferenca > 62) {
    throw new Error(
      `Período máximo é 62 dias. Informado: ${Math.ceil(diasDiferenca)} dias. Reduza o intervalo ou separe em múltiplas chamadas.`
    );
  }

  const body = {
    schedules: emails,
    startTime: {
      dateTime: data_inicio,
      timeZone: fuso_horario,
    },
    endTime: {
      dateTime: data_fim,
      timeZone: fuso_horario,
    },
    availabilityViewInterval: intervalo_minutos,
  };

  const result = await graphRequest("POST", "/me/calendar/getSchedule", body);

  if (!result || !result.value || result.value.length === 0) {
    return "Nenhuma informação de disponibilidade retornada.";
  }

  // A Graph API retorna scheduleItems[].start com { dateTime, timeZone }.
  // O timeZone da resposta frequentemente é "UTC" mesmo quando a requisição
  // especifica outro fuso. Precisamos converter para o fuso solicitado.
  function toLocalHHMM(dateTimeStr, sourceTZ, targetTZ) {
    // Limpa frações de segundo do formato Graph API (ex: ".0000000")
    const clean = dateTimeStr.split(".")[0];

    // Se timezone de origem = destino (ou não informada), extrai direto
    if (!sourceTZ || sourceTZ === targetTZ) {
      const timePart = clean.split("T")[1] || "00:00";
      return timePart.substring(0, 5);
    }

    // Converte de sourceTZ para targetTZ
    let utcMs;
    if (sourceTZ.toLowerCase() === "utc") {
      // dateTime está em UTC — adiciona Z para criar Date correto
      utcMs = new Date(clean + "Z").getTime();
    } else {
      // Para outros fusos: descobre o offset do sourceTZ e ajusta para UTC
      const naiveUTC = new Date(clean + "Z");
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: sourceTZ,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false,
      }).formatToParts(naiveUTC);
      const get = (type) => parseInt(parts.find((p) => p.type === type)?.value || "0");
      const hr = get("hour") === 24 ? 0 : get("hour");
      const localAsUTC = Date.UTC(get("year"), get("month") - 1, get("day"), hr, get("minute"), get("second"));
      const offsetMs = localAsUTC - naiveUTC.getTime();
      utcMs = naiveUTC.getTime() - offsetMs;
    }

    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: targetTZ,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(utcMs));
  }

  // Monta mapa de disponibilidade por pessoa
  const pessoasInfo = result.value.map((schedule) => {
    const email = schedule.scheduleId;
    const status = schedule.availabilityView || "";
    // availabilityView: string de chars onde 0=livre, 1=tentativa, 2=ocupado, 3=fora do escritório, 4=trabalhando em outro local

    const blocos = schedule.scheduleItems || [];
    const ocupados = blocos.map((item) => {
      const iniStr = toLocalHHMM(item.start.dateTime, item.start.timeZone, fuso_horario);
      const fimStr = toLocalHHMM(item.end.dateTime, item.end.timeZone, fuso_horario);
      const titulo = item.subject ? ` — "${item.subject}"` : "";
      const tipoStatus = item.status === "oof" ? " [Fora do escritório]" : item.status === "tentative" ? " [Tentativa]" : "";
      return `  • ${iniStr} – ${fimStr}${titulo}${tipoStatus}`;
    });

    return { email, status, ocupados };
  });

  // Encontra janelas livres em comum para TODOS
  // availabilityView é uma string: cada char = um intervalo de `intervalo_minutos` minutos a partir de data_inicio
  const views = pessoasInfo.map((p) => p.status);
  const minLen = Math.min(...views.map((v) => v.length));

  const janelasLivres = [];
  let inicioJanela = null;

  for (let i = 0; i < minLen; i++) {
    const todosLivres = views.every((v) => v[i] === "0");

    if (todosLivres && inicioJanela === null) {
      inicioJanela = i;
    } else if (!todosLivres && inicioJanela !== null) {
      janelasLivres.push({ inicio: inicioJanela, fim: i });
      inicioJanela = null;
    }
  }
  if (inicioJanela !== null) {
    janelasLivres.push({ inicio: inicioJanela, fim: minLen });
  }

  // Converte índices para horários legíveis a partir da hora de início (já local)
  const [baseDate, baseTime] = data_inicio.split("T");
  const [baseH, baseM] = baseTime.split(":").map(Number);
  const baseMinutes = baseH * 60 + baseM;

  function minutesToHHMM(totalMinutes) {
    const h = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
    const m = (totalMinutes % 60).toString().padStart(2, "0");
    return `${h}:${m}`;
  }

  const janelasStr = janelasLivres
    .map((j) => {
      const iniStr = minutesToHHMM(baseMinutes + j.inicio * intervalo_minutos);
      const fimStr = minutesToHHMM(baseMinutes + j.fim * intervalo_minutos);
      const durMin = (j.fim - j.inicio) * intervalo_minutos;
      return `  ✅ ${iniStr} – ${fimStr} (${durMin} min livre)`;
    })
    .join("\n");

  // Monta output por pessoa
  const detalhes = pessoasInfo.map((p) => {
    const ocupStr =
      p.ocupados.length > 0 ? p.ocupados.join("\n") : "  (sem compromissos no período)";
    return `👤 ${p.email}\n${ocupStr}`;
  });

  const [, iniTimePart] = data_inicio.split("T");
  const [, fimTimePart] = data_fim.split("T");
  const dataExib = baseDate.split("-").reverse().join("/");
  const iniExib = iniTimePart.substring(0, 5);
  const fimExib = fimTimePart.substring(0, 5);

  const header = `Disponibilidade — ${dataExib} — ${iniExib} até ${fimExib}\n${"─".repeat(50)}`;
  const blocoDetalhes = `\n📅 Compromissos no período:\n${detalhes.join("\n\n")}`;
  const blocoJanelas =
    janelasLivres.length > 0
      ? `\n\n🟢 Janelas livres para TODOS (${emails.join(", ")}):\n${janelasStr}`
      : `\n\n🔴 Nenhuma janela livre em comum no período.`;

  return header + blocoDetalhes + blocoJanelas;
}
