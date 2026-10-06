require('dotenv').config();
const http = require('http'); // Servidor HTTP para o Render
const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
} = require('discord.js');
const path = require('path');
const fs = require('fs');

// ---------- Servidor HTTP para satisfazer a checagem de porta do Render ----------
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Assistente Caveiras online!');
}).listen(PORT, () => {
  console.log(`[Render] Servidor Web ativo na porta ${PORT}`);
});

const env = process.env;
const lista = (v = '') => v.split(',').map((s) => s.trim()).filter(Boolean);

const cfg = {
  token: (env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,
  catAtendimento: env.CATEGORIA_ATENDIMENTO_ID,
  catEscalonado: env.CATEGORIA_ESCALONADO_ID,
  cargoAdm: env.CARGO_ADM_ID,
  cargoModerador: env.CARGO_MODERADOR_ID || '1404521279775834184', // também pode usar o /relatorio
  cargosAtendimento: lista(env.CARGOS_ATENDIMENTO_IDS),
  logChannel: env.LOG_CHANNEL_ID || null,
  alertaChannel: env.ALERTA_CHANNEL_ID || null,
  revogar: (env.REVOGAR_ACESSO_ATENDIMENTO ?? 'true') === 'true',
  canalCastigo: env.CANAL_CASTIGO_ID || null,
  castigoDias: Number(env.CASTIGO_DIAS ?? 7),
  castigoAlertaChannel: env.CASTIGO_ALERTA_CHANNEL_ID || null,
  backupChannel: env.BACKUP_CHANNEL_ID || env.LOG_CHANNEL_ID || null,
  deployCmds: (env.DEPLOY_CMDS ?? 'false') === 'true',
  urlPlanilhaApi: env.URL_PLANILHA_API || null, // URL gerada no Apps Script
  
  // ---------- Canais de Voz & Ranking ----------
  canalBackupVoz: '1556730438104514670',
  canalRankingVoz: '1556729125195218974',
};

// =====================================================================
// 🏆 CONFIGURAÇÃO VISUAL DO RANKING
// =====================================================================
const RANKING_CFG = {
  titulo: '🏆 Ranking de Tempo em Call dos Caveiras',
  corEmbed: 0x9333ea,
  textoVazio: 'Nenhum tempo registrado ainda. Bora entrar em uma call!',
  
  medalhas: [
    '🥇 **[1º - Já pode pedir música no Fantástico]**',
    '🥈 **[2º - A cama sente sua falta]**',
    '🥉 **[3º - Banho é DLC?]**',
    '🏅 **[4º - Viu a luz do sol recentemente?]**',
    '🏅 **[5º - Possui vínculo empregatício com o Discord]**',
    '🏅 **[6º - Já tem endereço fixo na call]**',
    '🏅 **[7º - A call conhece mais você que sua família]**',
    '🏅 **[8º - Seu Discord está preocupado com você]**',
    '🏅 **[9º - Só sai quando acaba a internet]**',
    '🏅 **[10º - Provavelmente está de cueca desde terça]**',
    '🏅 **[11º - A cadeira já moldou seu corpo]**',
    '🏅 **[12º - Entra na call antes de entrar no Windows]**'
  ],
  
  posicaoPadrao: '**{pos}º**'
};
// =====================================================================

for (const k of ['token', 'clientId', 'guildId', 'catAtendimento', 'catEscalonado', 'cargoAdm']) {
  if (!cfg[k]) {
    console.error(`Variável de ambiente ausente para "${k}". Confira o .env`);
    process.exit(1);
  }
}

// ---------- Identidade visual ----------
const COR = {
  escalonado: 0xf59e0b,
  devolvido: 0x22c55e,
  alerta: 0xdc2626,
  ok: 0x3b82f6,
  erro: 0xef4444,
  sorteio: 0xf1c40f,
  voz: RANKING_CFG.corEmbed,
};
const RODAPE = 'Caveiras • Sistema Automatizado';
const citar = (texto) => `>>> ${texto}`;
const EPH = MessageFlags.Ephemeral;

const aviso = (cor, titulo, descricao) =>
  new EmbedBuilder().setColor(cor).setTitle(titulo).setDescription(descricao);

const autor = (i, prefixo) => ({
  name: `${prefixo}${i.member?.displayName ?? i.user.username}`,
  iconURL: i.user.displayAvatarURL(),
});

async function enviarEm(guild, canalId, payload) {
  if (!canalId) return;
  const canal = guild.channels.cache.get(canalId);
  await canal?.send(payload).catch((e) => console.error('Falha ao enviar:', e.message));
}

// ---------- Cargos de autosserviço ----------
const CARGOS_PAINEL = [
  { id: '1555231437651972201', label: '💣 Hell Let Loose' },
  { id: '1555231449907470506', label: '🐶 Wardogs' },
  { id: '1555235580625944576', label: '🎖 Premiações' },
  { id: '1555235317550948434', label: '🪖 Eventos' },
  { id: '1555235262018228295', label: '🎮 Casual' },
  { id: '1555235062918680668', label: '🏆 Competitivo' },
];
const PREFIXO_BOTAO_CARGO = 'cargo:';

function linhasBotoesCargos() {
  const linhas = [];
  for (let j = 0; j < CARGOS_PAINEL.length; j += 5) {
    const grupo = CARGOS_PAINEL.slice(j, j + 5);
    linhas.push(
      new ActionRowBuilder().addComponents(
        grupo.map((c) =>
          new ButtonBuilder().setCustomId(`${PREFIXO_BOTAO_CARGO}${c.id}`).setLabel(c.label).setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }
  return linhas;
}

// ---------- Comandos ----------
const comandoEscalonar = new SlashCommandBuilder()
  .setName('escalonar').setDescription('Escalona este ticket para a administração')
  .addStringOption((o) => o.setName('motivo').setDescription('Motivo do escalonamento').setMaxLength(500).setRequired(true)).setDMPermission(false);

const comandoCheater = new SlashCommandBuilder()
  .setName('cheater').setDescription('Sinaliza suspeita de cheater e escalona o ticket com prioridade')
  .addStringOption((o) => o.setName('jogador').setDescription('Nick ou ID do suspeito').setMaxLength(100).setRequired(true))
  .addStringOption((o) => o.setName('motivo').setDescription('Motivo').setMaxLength(500).setRequired(true))
  .addStringOption((o) => o.setName('evidencia').setDescription('Evidência').setMaxLength(300)).setDMPermission(false);

const comandoDevolver = new SlashCommandBuilder()
  .setName('devolver').setDescription('Devolve este ticket (só ADM)')
  .addStringOption((o) => o.setName('motivo').setDescription('Motivo da devolução').setMaxLength(500).setRequired(true)).setDMPermission(false);

const comandoSorteioKabum = new SlashCommandBuilder()
  .setName('sorteiovipkabum').setDescription('Anuncia sorteio Kabum (só ADM)')
  .addIntegerOption((o) => o.setName('dias').setDescription('Duração').setMinValue(1).setMaxValue(30)).setDMPermission(false);

const comandoRelatorio = new SlashCommandBuilder()
  .setName('relatorio').setDescription('Puxa o relatório de operações da planilha (ADM e moderação)').setDMPermission(false)
  .addIntegerOption((o) =>
    o.setName('partida').setDescription('Qual partida com Caveiras mostrar (1 = a mais recente)').setMinValue(1).setMaxValue(10),
  );

const comandoSorteioEncerrar = new SlashCommandBuilder().setName('sorteio-encerrar').setDescription('Encerra sorteio ativo (só ADM)').setDMPermission(false);
const comandoSorteioStatus = new SlashCommandBuilder().setName('sorteio-status').setDescription('Mostra quem está participando (só ADM)').setDMPermission(false);
const comandoCargosPainel = new SlashCommandBuilder().setName('cargos-painel').setDescription('Posta painel de cargos (só ADM)').setDMPermission(false);
const comandoAvisoArmadilha = new SlashCommandBuilder().setName('aviso-armadilha').setDescription('Posta aviso da armadilha (só ADM)').setDMPermission(false);

// ---------- 🎙️ RANKING E TEMPO DE VOZ ----------
const DADOS_VOZ = path.join(__dirname, 'data', 'voz.json');
const NOME_BACKUP_VOZ = 'voz-backup.json';

function carregarVozLocal() {
  try { return JSON.parse(fs.readFileSync(DADOS_VOZ, 'utf8')); } catch { return {}; }
}

let temposVoz = carregarVozLocal(); 
let sessoesVoz = {}; 
let msgRankingId = null;
let backupVozMsgId = null;

function salvarVozLocal() {
  try {
    fs.mkdirSync(path.dirname(DADOS_VOZ), { recursive: true });
    fs.writeFileSync(DADOS_VOZ, JSON.stringify(temposVoz, null, 2));
  } catch (e) { console.error('Erro ao salvar voz.json local:', e.message); }
}

function adicionarTempoVoz(userId, duracaoMs) {
  const dadosSalvos = carregarVozLocal();
  temposVoz = { ...dadosSalvos, ...temposVoz }; 
  
  if (!temposVoz[userId]) temposVoz[userId] = 0;
  temposVoz[userId] += duracaoMs;
  
  salvarVozLocal();
}

function getTemposAtuaisVoz() {
  const agora = Date.now();
  const combinados = { ...temposVoz };
  for (const [id, start] of Object.entries(sessoesVoz)) {
    if (!combinados[id]) combinados[id] = 0;
    combinados[id] += (agora - start);
  }
  return combinados;
}

async function mapearMembrosEmVoz(client) {
  const agora = Date.now();
  try {
    const guild = await client.guilds.fetch(cfg.guildId);
    const channels = await guild.channels.fetch();
    for (const [, channel] of channels) {
      if (channel?.isVoiceBased()) {
        for (const [, member] of channel.members) {
          if (!member.user.bot && !sessoesVoz[member.id]) {
            sessoesVoz[member.id] = agora;
          }
        }
      }
    }
  } catch (e) {
    console.error('[voz] Erro ao mapear membros em voz:', e.message);
  }
}

function formatarTempo(ms) {
  const totalMin = Math.floor(ms / 60000);
  const horas = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (horas > 0) return `${horas}h${min}m`;
  return `${min}m`;
}

async function enviarBackupVoz(client) {
  if (!client || !cfg.canalBackupVoz) return;
  try {
    const canal = await client.channels.fetch(cfg.canalBackupVoz).catch(() => null);
    if (!canal) return;

    const dadosParaBackup = getTemposAtuaisVoz();

    const msgs = await canal.messages.fetch({ limit: 20 }).catch(() => null);
    const msgsAntigas = msgs ? msgs.filter(m => m.author.id === client.user.id && m.attachments.some(a => a.name === NOME_BACKUP_VOZ)) : null;

    const msg = await canal.send({
      content: `🎙️ Backup Automático: Tempo de Voz (${Object.keys(dadosParaBackup).length} registros)`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(dadosParaBackup, null, 2)), { name: NOME_BACKUP_VOZ })]
    });
    backupVozMsgId = msg.id;

    if (msgsAntigas && msgsAntigas.size > 0) {
      for (const [, m] of msgsAntigas) {
        if (m.id !== msg.id) await m.delete().catch(() => {});
      }
    }
  } catch (e) { console.error('[voz] Falha ao enviar backup:', e.message); }
}

async function restaurarBackupVoz(client) {
  if (!cfg.canalBackupVoz) return;
  try {
    const canal = await client.channels.fetch(cfg.canalBackupVoz).catch(() => null);
    if (!canal) return;
    const msgs = await canal.messages.fetch({ limit: 20 });
    const alvo = [...msgs.values()]
      .filter(m => m.author.id === client.user.id && m.attachments.some(a => a.name === NOME_BACKUP_VOZ))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];

    if (alvo) {
      backupVozMsgId = alvo.id;
      const anexo = alvo.attachments.find(a => a.name === NOME_BACKUP_VOZ);
      const resp = await fetch(anexo.url);
      const salvo = await resp.json();
      
      if (salvo && typeof salvo === 'object') {
        temposVoz = salvo;
        salvarVozLocal();
        console.log('[voz] Dados de voz restaurados com sucesso do voz-backup.json.');
      }
    } else { 
      temposVoz = carregarVozLocal();
    }
  } catch (e) { 
    console.error('[voz] Erro ao carregar o backup do Discord:', e.message);
    temposVoz = carregarVozLocal();
  }
}

async function atualizarRanking(client) {
  try {
    const canal = await client.channels.fetch(cfg.canalRankingVoz).catch(() => null);
    if (!canal) return;

    const dados = getTemposAtuaisVoz();
    const rank = Object.entries(dados)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    let textoRank = rank.length > 0
      ? rank.map(([id, ms], i) => {
          const posicaoTag = RANKING_CFG.medalhas[i] || RANKING_CFG.posicaoPadrao.replace('{pos}', i + 1);
          return `${posicaoTag} <@${id}> — \`${formatarTempo(ms)}\``;
        }).join('\n\n')
      : RANKING_CFG.textoVazio;

    const embed = new EmbedBuilder()
      .setColor(RANKING_CFG.corEmbed)
      .setTitle(RANKING_CFG.titulo)
      .setDescription(textoRank)
      .setFooter({ text: 'Atualizado automaticamente a cada 2 minutos • ' + RODAPE })
      .setTimestamp();

    const ultimas = await canal.messages.fetch({ limit: 10 });
    const minhasMsgs = Array.from(ultimas.values()).filter(m => m.author.id === client.user.id);

    if (minhasMsgs.length > 0) {
      const primeiraMsg = minhasMsgs[0];
      msgRankingId = primeiraMsg.id;
      await primeiraMsg.edit({ embeds: [embed] });

      for (let i = 1; i < minhasMsgs.length; i++) {
        await minhasMsgs[i].delete().catch(() => {});
      }
    } else {
      const enviada = await canal.send({ embeds: [embed] });
      msgRankingId = enviada.id;
    }
  } catch (e) { console.error('[voz] Erro ao atualizar o ranking:', e.message); }
}

// ---------- Persistência do sorteio ----------
const DADOS_SORTEIO = path.join(__dirname, 'data', 'sorteio.json');
const PREFIXO_BOTAO_SORTEIO = 'sorteio_participar';

const CARGOS_PODEM_PARTICIPAR = [
  '1400511336437514452', '1401000578372604028', '1404521279775834184',
  '409442142667145247', '1401534428416708779', '1419044618711994510',
];

function carregarSorteio() { try { return JSON.parse(fs.readFileSync(DADOS_SORTEIO, 'utf8')); } catch { return null; } }
function salvarSorteio(s) {
  try {
    fs.mkdirSync(path.dirname(DADOS_SORTEIO), { recursive: true });
    fs.writeFileSync(DADOS_SORTEIO, JSON.stringify(s, null, 2));
  } catch (e) {}
  agendarBackupSorteio();
}

let sorteio = carregarSorteio(); 

const NOME_BACKUP_SORTEIO = 'sorteio-backup.json';
let clientBackup = null;
let backupSorteioTimer = null;
let backupSorteioMsgId = null;
let filaBackupSorteio = Promise.resolve();

function agendarBackupSorteio() {
  if (!clientBackup || !cfg.backupChannel || backupSorteioTimer) return;
  backupSorteioTimer = setTimeout(() => {
    backupSorteioTimer = null;
    filaBackupSorteio = filaBackupSorteio.then(enviarBackupSorteio).catch(() => {});
  }, 5000);
}

async function enviarBackupSorteio() {
  if (!sorteio || !clientBackup || !cfg.backupChannel) return;
  try {
    const canal = await clientBackup.channels.fetch(cfg.backupChannel);
    const anteriorId = backupSorteioMsgId;
    const msg = await canal.send({
      content: `💾 Backup automático do sorteio — ${sorteio.participantes.length} participante(s).`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(sorteio, null, 2)), { name: NOME_BACKUP_SORTEIO })],
      allowedMentions: { parse: [] },
    });
    backupSorteioMsgId = msg.id;
    if (anteriorId) await canal.messages.delete(anteriorId).catch(() => {});
  } catch (e) { console.error('[backup sorteio] falha:', e.message); }
}

async function restaurarBackupSorteio(client) {
  if (!cfg.backupChannel) return;
  try {
    const canal = await client.channels.fetch(cfg.backupChannel).catch(()=>null);
    if (!canal) return;
    const msgs = await canal.messages.fetch({ limit: 100 });
    const alvo = [...msgs.values()]
      .filter((m) => m.author.id === client.user.id && m.attachments.some((a) => a.name === NOME_BACKUP_SORTEIO))
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];

    if (alvo) {
      backupSorteioMsgId = alvo.id;
      const anexo = alvo.attachments.find((a) => a.name === NOME_BACKUP_SORTEIO);
      const resp = await fetch(anexo.url);
      const salvo = await resp.json();
      if (salvo && Array.isArray(salvo.participantes)) {
        if (!sorteio) sorteio = salvo;
        else if (sorteio.messageId === salvo.messageId) {
          sorteio.participantes = [...new Set([...sorteio.participantes, ...salvo.participantes])];
          sorteio.sorteado = Boolean(sorteio.sorteado || salvo.sorteado);
        }
        salvarSorteio(sorteio);
      }
    }
  } catch (e) { console.error('[backup sorteio] erro restauração:', e.message); }
}

async function finalizar() {
  setTimeout(() => process.exit(0), 10000).unref();
  salvarVozLocal();
  await filaBackupSorteio;
  process.exit(0);
}

process.on('SIGTERM', finalizar);
process.on('SIGINT', finalizar);

function linhaBotaoSorteio(desativado = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PREFIXO_BOTAO_SORTEIO).setLabel('Participar').setEmoji('🎟️').setStyle(ButtonStyle.Success).setDisabled(desativado)
  );
}

async function sortearGanhador(client) {
  if (!sorteio || sorteio.sorteado) return;
  sorteio.sorteado = true;
  salvarSorteio(sorteio);

  try {
    const canal = await client.channels.fetch(sorteio.channelId).catch(() => null);
    if (!canal) return;

    const msgOriginal = await canal.messages.fetch(sorteio.messageId).catch(() => null);
    if (msgOriginal) await msgOriginal.edit({ components: [linhaBotaoSorteio(true)] }).catch(() => {});

    if (sorteio.participantes.length === 0) {
      await canal.send({
        embeds: [new EmbedBuilder().setColor(COR.erro).setTitle('🎉 Sorteio Encerrado').setDescription('Ninguém participou.').setFooter({ text: RODAPE })],
      });
      return;
    }
    const ganhadorId = sorteio.participantes[Math.floor(Math.random() * sorteio.participantes.length)];
    await canal.send({
      content: `🎉 <@${ganhadorId}> é o grande ganhador do **Sorteio VIP Kabum**! Parabéns! 🎉`,
      embeds: [
        new EmbedBuilder().setColor(COR.sorteio).setTitle('🏆 Temos um ganhador!').setDescription(`🏆 Ganhador: <@${ganhadorId}>`)
          .addFields({ name: 'Participantes', value: `${sorteio.participantes.length}`, inline: true }).setFooter({ text: RODAPE })
      ],
    });
  } catch (e) {}
}

// ---------- Relatório de partidas (planilha / Apps Script) ----------
const cortar = (txt, max) => {
  const t = String(txt ?? '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Tira a tag do clã e escapa caracteres que quebrariam a formatação do Discord
const nomeLimpo = (nome) => {
  const original = String(nome ?? '').trim();
  const semTag = original.replace(/ャ/g, '').replace(/\s+/g, ' ').trim();
  return cortar(semTag || original, 22).replace(/([\\*_~`|>])/g, '\\$1');
};

const formatarDuracao = (min) => {
  const m = Math.round(Number(min) || 0);
  if (!m) return 'n/d';
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}min` : `${m}min`;
};

// Uma seção = 3 campos "inline" lado a lado (até 3 colunas de largura), com o título na primeira coluna.
function camposDaSecao(titulo, nomes) {
  const n = nomes.length;
  const colunas = Math.min(3, Math.max(1, Math.ceil(n / 3)));
  const porColuna = Math.ceil(n / colunas);
  const campos = [];
  for (let c = 0; c < 3; c++) {
    const fatia = c < colunas ? nomes.slice(c * porColuna, (c + 1) * porColuna) : [];
    campos.push({
      name: c === 0 ? cortar(`${titulo} (${n})`, 256) : '\u200b',
      value: fatia.length ? fatia.map((x) => `• ${nomeLimpo(x)}`).join('\n').slice(0, 1024) : '\u200b',
      inline: true,
    });
  }
  return campos;
}

function montarEmbedRelatorio(p) {
  const cores = { 'Vitória': 0x22c55e, 'Derrota': 0xef4444, 'Empate': 0xf59e0b };
  const icones = { 'Vitória': '🟢', 'Derrota': '🔴', 'Empate': '🟡' };
  const resultado = p.resultado || 'Sem resultado';
  const placar =
    p.placarAliados !== '' && p.placarEixo !== '' ? `Aliados ${p.placarAliados} x ${p.placarEixo} Eixo` : 'Placar indisponível';

  const lista = (v) => (Array.isArray(v) ? v : []);
  const secoes = [];
  let aviso = '';
  if (p.temClasses) {
    secoes.push(['🪖 Infantaria', lista(p.infantaria)], ['🛡️ Tanques', lista(p.tanques)], ['💥 Artilharia', lista(p.artilharia)]);
  } else {
    const nomes = String(p.nomes || '').split(',').map((x) => x.trim()).filter(Boolean);
    secoes.push(['👥 Jogadores Caveiras', nomes]);
    aviso = '\n_Classes ainda não registradas para esta partida._';
  }

  const campos = secoes.filter(([, nomes]) => nomes.length > 0).flatMap(([titulo, nomes]) => camposDaSecao(titulo, nomes));

  const descricao =
    `📍 **${cortar(p.servidor, 30) || '?'}** · 🕒 ${p.inicio || 'sem data'}\n` +
    `⚔️ Lado: **${p.lado || 'Desconhecido'}** · 👥 **${p.caveiras}** Caveiras (de ${p.total} jogadores)${aviso}`;

  const embed = new EmbedBuilder()
    .setColor(cores[p.resultado] ?? 0x000000)
    .setTitle('💀 RELATÓRIO DE OPERAÇÃO - CAVEIRAS 💀')
    .setDescription(descricao)
    .setFooter({
      text: `🗺️ ${cortar(p.mapa, 50) || 'Mapa desconhecido'} • ${icones[p.resultado] || '⚪'} ${resultado} • ${placar} • ⏱️ ${formatarDuracao(p.duracao)}`,
    });
  if (campos.length) embed.addFields(campos);
  return embed;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  clientBackup = c;
  
  await restaurarBackupSorteio(c);
  await restaurarBackupVoz(c);
  await mapearMembrosEmVoz(c);

  // Registra os comandos quando DEPLOY_CMDS=true OU quando algum comando do bot ainda não existe no servidor
  try {
    const rest = new REST().setToken(cfg.token);
    const corpo = [
      comandoEscalonar, comandoCheater, comandoDevolver,
      comandoAvisoArmadilha, comandoCargosPainel, comandoSorteioKabum,
      comandoSorteioEncerrar, comandoSorteioStatus, comandoRelatorio,
    ].map((cmd) => cmd.toJSON());

    let registrar = cfg.deployCmds;
    if (!registrar) {
      const atuais = await rest.get(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId));
      const assinatura = (cmd) =>
        JSON.stringify([
          cmd.description,
          (cmd.options || []).map((o) => [o.name, o.type, !!o.required, o.min_value ?? null, o.max_value ?? null]),
        ]);
      const pendentes = corpo
        .filter((cmd) => {
          const atual = atuais.find((x) => x.name === cmd.name);
          return !atual || assinatura(atual) !== assinatura(cmd);
        })
        .map((cmd) => cmd.name);
      if (pendentes.length) {
        console.log(`Comandos novos ou alterados: ${pendentes.join(', ')} — registrando.`);
        registrar = true;
      }
    }

    if (registrar) {
      await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), { body: corpo });
      console.log(`Comandos registrados (${corpo.length}).`);
    } else {
      console.log('Comandos já estão registrados no servidor.');
    }
  } catch (err) {
    console.error('Falha ao registrar comandos (confira CLIENT_ID, GUILD_ID e se o bot foi convidado com o escopo applications.commands):', err);
  }

  console.log(`Online como ${c.user.tag}`);

  if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) sortearGanhador(c);
  setInterval(() => {
    if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) sortearGanhador(c);
  }, 15000);

  setInterval(() => enviarBackupVoz(clientBackup), 5 * 60 * 1000);
  setInterval(() => atualizarRanking(clientBackup), 2 * 60 * 1000);
});

// ---------- EVENTOS DE VOZ ----------
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (oldState.member?.user.bot) return;

  const id = newState.member.id;
  const noCanal = !!newState.channelId;
  const tavaNoCanal = !!oldState.channelId;

  if (!tavaNoCanal && noCanal) {
    sessoesVoz[id] = Date.now();
  } else if (tavaNoCanal && !noCanal) {
    if (sessoesVoz[id]) {
      const start = sessoesVoz[id];
      const duracao = Date.now() - start;
      adicionarTempoVoz(id, duracao);
      delete sessoesVoz[id];
    }
  }
});

// ---------- Comandos (Interactions) ----------
client.on(Events.InteractionCreate, async (i) => {
  if (i.isCommand()) {
    const isMod = i.member.roles.cache.has(cfg.cargoAdm);
    const { commandName: cmd } = i;

    if (cmd === 'escalonar') {
      const ticketId = i.channel.name.split('-')[1];
      if (i.channel.parentId !== cfg.catAtendimento || !ticketId) return i.reply({ content: 'Use dentro de um ticket de atendimento.', flags: EPH });
      await i.channel.setParent(cfg.catEscalonado, { lockPermissions: false });
      
      const p = cfg.cargosAtendimento.map((r) => i.channel.permissionOverwrites.create(r, { ViewChannel: false })).filter(Boolean);
      await Promise.all(p).catch(() => {});

      if (cfg.revogar) {
        const uId = ticketId;
        const u = i.guild.members.cache.get(uId);
        if (u) await i.channel.permissionOverwrites.create(uId, { ViewChannel: false }).catch(() => {});
      }
      const pId = cfg.cargosAtendimento[0];
      await i.reply({
        content: pId ? `<@&${pId}>` : '',
        embeds: [aviso(COR.escalonado, '⬆️ Escalonado', citar(i.options.getString('motivo'))).setAuthor(autor(i, 'Por'))],
      });
      await enviarEm(i.guild, cfg.logChannel, {
        embeds: [aviso(COR.escalonado, 'Log: Escalonado', `**Ticket:** ${i.channel.name}\n**Por:** <@${i.user.id}>\n**Motivo:** ${i.options.getString('motivo')}`)],
      });

    } else if (cmd === 'cheater') {
      const ticketId = i.channel.name.split('-')[1];
      if (i.channel.parentId !== cfg.catAtendimento || !ticketId) return i.reply({ content: 'Use dentro de um ticket de atendimento.', flags: EPH });
      await i.channel.setParent(cfg.catEscalonado, { lockPermissions: false });
      
      const p = cfg.cargosAtendimento.map((r) => i.channel.permissionOverwrites.create(r, { ViewChannel: false })).filter(Boolean);
      await Promise.all(p).catch(() => {});

      const j = i.options.getString('jogador');
      const m = i.options.getString('motivo');
      const ev = i.options.getString('evidencia');
      
      const pId = cfg.cargosAtendimento[0];
      const ebd = aviso(COR.alerta, '🚨 REPORT DE CHEATER (PRIORIDADE)', `**Jogador Suspeito:** \`${j}\`\n**Motivo:** ${m}${ev ? `\n**Evidência:** ${ev}` : ''}`).setAuthor(autor(i, 'Reportado por'));
      
      await i.reply({ content: pId ? `<@&${pId}>` : '', embeds: [ebd] });
      await enviarEm(i.guild, cfg.alertaChannel, {
        content: pId ? `<@&${pId}>` : '',
        embeds: [aviso(COR.alerta, 'Alerta de Cheater', `Ticket: ${i.channel}\nPor: <@${i.user.id}>\nSuspeito: \`${j}\``)],
      });

    } else if (cmd === 'devolver') {
      if (!isMod) return i.reply({ content: 'Somente a administração.', flags: EPH });
      if (i.channel.parentId !== cfg.catEscalonado) return i.reply({ content: 'O canal não está escalonado.', flags: EPH });
      
      await i.channel.setParent(cfg.catAtendimento, { lockPermissions: false });
      const p = cfg.cargosAtendimento.map((r) => i.channel.permissionOverwrites.delete(r)).filter(Boolean);
      await Promise.all(p).catch(() => {});
      
      const uId = i.channel.name.split('-')[1];
      if (cfg.revogar && uId) await i.channel.permissionOverwrites.delete(uId).catch(() => {});
      
      await i.reply({ embeds: [aviso(COR.devolvido, '⬇️ Devolvido', citar(i.options.getString('motivo'))).setAuthor(autor(i, 'Por'))] });

    } else if (cmd === 'sorteiovipkabum') {
      if (!isMod) return i.reply({ content: 'Restrito para administração.', flags: EPH });
      const dias = i.options.getInteger('dias') || 7;
      const ms = dias * 24 * 60 * 60 * 1000;
      const t = Date.now() + ms;
      const unix = Math.floor(t / 1000);

      const msg = await i.reply({
        embeds: [
          new EmbedBuilder().setColor(COR.sorteio).setTitle('🎉 Sorteio VIP Kabum da Caveiras! 🎉')
            .setDescription(`**Prêmio:** VIP Kabum\n**Duração:** ${dias} dia(s)\n**Encerra em:** <t:${unix}:R> (<t:${unix}:F>)\n\nClique no botão abaixo para participar!`)
            .setFooter({ text: RODAPE }),
        ],
        components: [linhaBotaoSorteio()],
        fetchReply: true,
      });

      sorteio = { channelId: i.channelId, messageId: msg.id, encerraEm: t, participantes: [], sorteado: false };
      salvarSorteio(sorteio);

    } else if (cmd === 'sorteio-encerrar') {
      if (!isMod) return i.reply({ content: 'Restrito.', flags: EPH });
      if (!sorteio || sorteio.sorteado) return i.reply({ content: 'Não há sorteio ativo.', flags: EPH });
      sorteio.encerraEm = Date.now();
      await sortearGanhador(client);
      return i.reply({ content: 'Sorteio encerrado com sucesso.', flags: EPH });

    } else if (cmd === 'sorteio-status') {
      if (!isMod) return i.reply({ content: 'Restrito.', flags: EPH });
      if (!sorteio) return i.reply({ content: 'Nenhum sorteio registrado.', flags: EPH });
      const q = sorteio.participantes.length;
      return i.reply({ content: `**Status:** ${sorteio.sorteado ? 'Encerrado' : 'Ativo'}\n**Participantes:** ${q}\n${sorteio.participantes.map((id) => `<@${id}>`).join(', ') || 'Ninguém'}`, flags: EPH });

    } else if (cmd === 'cargos-painel') {
      if (!isMod) return i.reply({ content: 'Sem permissão.', flags: EPH });
      await i.channel.send({
        embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('🎯 Cargos e Interesses').setDescription('Selecione abaixo os cargos que deseja receber/remover:').setFooter({ text: RODAPE })],
        components: linhasBotoesCargos(),
      });
      return i.reply({ content: 'Painel enviado.', flags: EPH });

    } else if (cmd === 'aviso-armadilha') {
      if (!isMod) return i.reply({ content: 'Sem permissão.', flags: EPH });
      await i.channel.send({
        embeds: [new EmbedBuilder().setColor(COR.alerta).setTitle('⚠️ REGRA IMPORTANTE: Regras de Armadilha').setDescription('Não perdoe armadilhas! Fique de olho no jogo.').setFooter({ text: RODAPE })],
      });
      return i.reply({ content: 'Aviso postado.', flags: EPH });
      
    } else if (cmd === 'relatorio') {
      // Integração com o Google Sheets (Apps Script publicado como Web App)
      const podeRelatorio = isMod || i.member.roles.cache.has(cfg.cargoModerador);
      if (!podeRelatorio) return i.reply({ content: 'Restrito para administração e moderação.', flags: EPH });
      if (!cfg.urlPlanilhaApi) return i.reply({ content: 'Falta configurar a URL_PLANILHA_API no Render.', flags: EPH });

      await i.deferReply(); // o Apps Script pode demorar alguns segundos

      try {
        const posicao = i.options.getInteger('partida') ?? 1;

        const url = new URL(cfg.urlPlanilhaApi.trim().replace(/^["']|["']$/g, ''));
        if (!url.pathname.endsWith('/exec')) {
          throw new Error('A URL_PLANILHA_API precisa terminar em /exec (a URL de implantação do Web App, não a do editor nem a /dev).');
        }
        url.searchParams.set('limit', '25');

        const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
        if (!resp.ok) throw new Error(`A planilha respondeu HTTP ${resp.status}.`);

        const corpo = await resp.text();
        let dados;
        try {
          dados = JSON.parse(corpo);
        } catch {
          const host = (() => { try { return new URL(resp.url).hostname; } catch { return '?'; } })();
          console.error(`[sheets] Resposta não-JSON de ${host} (HTTP ${resp.status}): ${corpo.slice(0, 300).replace(/\s+/g, ' ')}`);
          if (host.includes('accounts.google.com')) {
            throw new Error('O Google pediu login. Na implantação do Apps Script, "Quem pode acessar" precisa ser "Qualquer pessoa".');
          }
          throw new Error('A URL não devolveu JSON. Confira se é a URL /exec da implantação atual e se o acesso é "Qualquer pessoa". O início da resposta está nos logs do Render.');
        }

        if (!Array.isArray(dados)) throw new Error(dados?.erro || 'Resposta inesperada da planilha.');
        if (dados.length > 0 && dados[0].player !== undefined && dados[0].servidor === undefined) {
          throw new Error('O Apps Script ainda está na versão antiga. Publique de novo: Implantar > Gerenciar implantações > Nova versão.');
        }

        // Só partidas em que realmente havia Caveiras (tag ャ), da mais recente para a mais antiga
        const partidas = dados.filter((d) => Number(d.caveiras) > 0).slice(0, 10);
        if (partidas.length === 0) return i.editReply('Nenhuma partida com Caveiras (ャ) encontrada na planilha.');

        const p = partidas[posicao - 1];
        if (!p) return i.editReply(`Só encontrei ${partidas.length} partida(s) com Caveiras. Escolha um número de 1 a ${partidas.length}.`);

        await i.editReply({ embeds: [montarEmbedRelatorio(p)] });
      } catch (err) {
        console.error('[sheets] Erro ao buscar os dados da planilha:', err);
        await i.editReply(`❌ Não consegui ler a planilha: ${err.message}`).catch(() => {});
      }
    }
  } else if (i.isButton()) {
    if (i.customId === PREFIXO_BOTAO_SORTEIO) {
      if (!sorteio || sorteio.sorteado) return i.reply({ content: 'Sorteio encerrado ou inválido.', flags: EPH });
      const temCargo = CARGOS_PODEM_PARTICIPAR.some((r) => i.member.roles.cache.has(r));
      if (!temCargo) return i.reply({ content: 'Você não tem um cargo VIP/Sub necessário para participar.', flags: EPH });
      if (sorteio.participantes.includes(i.user.id)) return i.reply({ content: 'Você já está participando!', flags: EPH });
      sorteio.participantes.push(i.user.id);
      salvarSorteio(sorteio);
      return i.reply({ content: 'Você entrou no sorteio! Boa sorte! 🎉', flags: EPH });

    } else if (i.customId.startsWith(PREFIXO_BOTAO_CARGO)) {
      const cargoId = i.customId.replace(PREFIXO_BOTAO_CARGO, '');
      const tem = i.member.roles.cache.has(cargoId);
      try {
        if (tem) {
          await i.member.roles.remove(cargoId);
          return i.reply({ content: `O cargo <@&${cargoId}> foi removido.`, flags: EPH });
        } else {
          await i.member.roles.add(cargoId);
          return i.reply({ content: `Você recebeu o cargo <@&${cargoId}>.`, flags: EPH });
        }
      } catch { return i.reply({ content: 'Erro ao gerenciar cargo. Verifique minhas permissões.', flags: EPH }); }
    }
  }
});

client.login(cfg.token);
