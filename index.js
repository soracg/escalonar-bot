require('dotenv').config();
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

const env = process.env;
const lista = (v = '') => v.split(',').map((s) => s.trim()).filter(Boolean);

const cfg = {
  token: (env.DISCORD_TOKEN || '').trim().replace(/^["']|["']$/g, ''),
  clientId: env.CLIENT_ID,
  guildId: env.GUILD_ID,
  catAtendimento: env.CATEGORIA_ATENDIMENTO_ID,
  catEscalonado: env.CATEGORIA_ESCALONADO_ID,
  cargoAdm: env.CARGO_ADM_ID,
  cargosAtendimento: lista(env.CARGOS_ATENDIMENTO_IDS), // Recrutador, Moderador
  logChannel: env.LOG_CHANNEL_ID || null,
  alertaChannel: env.ALERTA_CHANNEL_ID || null, // opcional: canal para alertas de cheater
  revogar: (env.REVOGAR_ACESSO_ATENDIMENTO ?? 'true') === 'true',
  canalCastigo: env.CANAL_CASTIGO_ID || null, // canal-armadilha (ex.: primeiro canal do servidor)
  castigoDias: Number(env.CASTIGO_DIAS ?? 7),
  castigoAlertaChannel: env.CASTIGO_ALERTA_CHANNEL_ID || null, // canal de avisos de castigo (spam/invasão)
  backupChannel: env.BACKUP_CHANNEL_ID || env.LOG_CHANNEL_ID || null, // canal do backup do SORTEIO
  deployCmds: (env.DEPLOY_CMDS ?? 'false') === 'true', // Controle para evitar Rate Limits
  
  // ---------- Canais de Voz & Ranking ----------
  canalBackupVoz: '1556730438104514670',
  canalRankingVoz: '1556729125195218974',
};

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
  voz: 0x9333ea,
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
  await canal?.send(payload).catch((e) => console.error('Falha ao enviar em canal auxiliar:', e.message));
}

// ---------- Cargos de autosserviço (botões) ----------
const CARGOS_PAINEL = [
  { id: '1555231437651972201', label: '💣 Hell Let Loose' },
  { id: '1555231449907470506', label: '🐶 Wardogs' },
  { id: '1555235580625944576', label: '🎖️ Premiações' },
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
          new ButtonBuilder()
            .setCustomId(`${PREFIXO_BOTAO_CARGO}${c.id}`)
            .setLabel(c.label)
            .setStyle(ButtonStyle.Secondary),
        ),
      ),
    );
  }
  return linhas;
}

// ---------- Comandos ----------
const comandoEscalonar = new SlashCommandBuilder()
  .setName('escalonar')
  .setDescription('Escalona este ticket para a administração')
  .addStringOption((o) => o.setName('motivo').setDescription('Motivo do escalonamento').setMaxLength(500).setRequired(true))
  .setDMPermission(false);

const comandoCheater = new SlashCommandBuilder()
  .setName('cheater')
  .setDescription('Sinaliza suspeita de cheater e escalona o ticket com prioridade')
  .addStringOption((o) => o.setName('jogador').setDescription('Nick ou ID do jogador suspeito').setMaxLength(100).setRequired(true))
  .addStringOption((o) => o.setName('motivo').setDescription('O que motivou a suspeita').setMaxLength(500).setRequired(true))
  .addStringOption((o) => o.setName('evidencia').setDescription('Link de vídeo/print ou descrição da prova, se houver').setMaxLength(300))
  .setDMPermission(false);

const comandoDevolver = new SlashCommandBuilder()
  .setName('devolver')
  .setDescription('Devolve este ticket para a categoria de atendimento (só ADM)')
  .addStringOption((o) => o.setName('motivo').setDescription('Motivo da devolução ao atendimento').setMaxLength(500).setRequired(true))
  .setDMPermission(false);

const comandoSorteioKabum = new SlashCommandBuilder()
  .setName('sorteiovipkabum')
  .setDescription('Anuncia o sorteio de R$500 em vale-presente da Kabum (só ADM)')
  .addIntegerOption((o) => o.setName('dias').setDescription('Duração do sorteio em dias (padrão: 3)').setMinValue(1).setMaxValue(30))
  .setDMPermission(false);

const comandoSorteioEncerrar = new SlashCommandBuilder().setName('sorteio-encerrar').setDescription('Encerra o sorteio ativo agora e sorteia o ganhador (só ADM)').setDMPermission(false);
const comandoSorteioStatus = new SlashCommandBuilder().setName('sorteio-status').setDescription('Mostra quem está participando do sorteio ativo (só ADM)').setDMPermission(false);
const comandoCargosPainel = new SlashCommandBuilder().setName('cargos-painel').setDescription('Posta o painel de botões para os membros pegarem seus cargos (só ADM)').setDMPermission(false);
const comandoAvisoArmadilha = new SlashCommandBuilder().setName('aviso-armadilha').setDescription('Posta e fixa o aviso explicando o canal-armadilha (só ADM)').setDMPermission(false);

// ---------- 🎙️ RANKING E TEMPO DE VOZ ----------
const DADOS_VOZ = path.join(__dirname, 'data', 'voz.json');
const NOME_BACKUP_VOZ = 'voz-backup.json';

let temposVoz = {}; // { "userId": milissegundos_totais }
let sessoesVoz = {}; // { "userId": timestamp_de_entrada }
let msgRankingId = null;
let backupVozMsgId = null;

function carregarVozLocal() {
  try { return JSON.parse(fs.readFileSync(DADOS_VOZ, 'utf8')); }
  catch { return {}; }
}

function salvarVozLocal() {
  try {
    fs.mkdirSync(path.dirname(DADOS_VOZ), { recursive: true });
    fs.writeFileSync(DADOS_VOZ, JSON.stringify(temposVoz, null, 2));
  } catch (e) { console.error('Erro ao salvar voz.json local:', e.message); }
}

function adicionarTempoVoz(userId, duracaoMs) {
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
    const canal = await client.channels.fetch(cfg.canalBackupVoz);
    const anteriorId = backupVozMsgId;
    const msg = await canal.send({
      content: `🎙️ Backup Automático: Tempo de Voz (${Object.keys(temposVoz).length} usuários registrados)`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(temposVoz, null, 2)), { name: NOME_BACKUP_VOZ })]
    });
    backupVozMsgId = msg.id;
    if (anteriorId) await canal.messages.delete(anteriorId).catch(() => {});
  } catch (e) {
    console.error('[voz] Falha ao enviar backup de voz:', e.message);
  }
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
      if (typeof salvo === 'object') {
        temposVoz = salvo;
        salvarVozLocal();
        console.log(`[voz] Backup restaurado: ${Object.keys(temposVoz).length} registros.`);
      }
    } else {
      temposVoz = carregarVozLocal();
    }
  } catch (e) {
    console.error('[voz] Erro na restauração:', e.message);
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
      .slice(0, 15); // Exibe o Top 15

    let textoRank = rank.length > 0
      ? rank.map(([id, ms], i) => `**${i + 1}º** <@${id}> — \`${formatarTempo(ms)}\``).join('\n\n')
      : 'Nenhum tempo registrado ainda. Entre em uma call!';

    const embed = new EmbedBuilder()
      .setColor(COR.voz)
      .setTitle('🏆 Ranking de Tempo em Call')
      .setDescription(textoRank)
      .setFooter({ text: 'Atualizado automaticamente a cada 5 minutos • ' + RODAPE })
      .setTimestamp();

    if (msgRankingId) {
      const msg = await canal.messages.fetch(msgRankingId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed] });
        return;
      }
    }

    const ultimas = await canal.messages.fetch({ limit: 10 });
    const minhaMsg = ultimas.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Ranking'));

    if (minhaMsg) {
      msgRankingId = minhaMsg.id;
      await minhaMsg.edit({ embeds: [embed] });
    } else {
      const enviada = await canal.send({ embeds: [embed] });
      msgRankingId = enviada.id;
    }
  } catch (e) {
    console.error('[voz] Erro ao atualizar o ranking:', e.message);
  }
}

// ---------- Persistência simples do sorteio ----------
const DADOS_SORTEIO = path.join(__dirname, 'data', 'sorteio.json');
const PREFIXO_BOTAO_SORTEIO = 'sorteio_participar';

const CARGOS_PODEM_PARTICIPAR = [
  '1400511336437514452', // Membro Efetivo
  '1401000578372604028', // Recruta
  '1404521279775834184', // Moderador
  '409442142667145247',  // ADM
  '1401534428416708779', // Recrutador
  '1419044618711994510', // Dev
];

function carregarSorteio() {
  try { return JSON.parse(fs.readFileSync(DADOS_SORTEIO, 'utf8')); } catch { return null; }
}

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
      content: `💾 Backup automático do sorteio — ${sorteio.participantes.length} participante(s). Não apague.`,
      files: [new AttachmentBuilder(Buffer.from(JSON.stringify(sorteio, null, 2)), { name: NOME_BACKUP_SORTEIO })],
      allowedMentions: { parse: [] },
    });
    backupSorteioMsgId = msg.id;
    if (anteriorId) await canal.messages.delete(anteriorId).catch(() => {});
  } catch (e) {
    console.error('[backup sorteio] falha ao enviar:', e.message);
  }
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
  } catch (e) { console.error('[backup sorteio] falha ao restaurar:', e.message); }
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
        embeds: [new EmbedBuilder().setColor(COR.erro).setTitle('🎉 Sorteio VIP Kabum encerrado').setDescription('Ninguém participou desta vez. 😢').setFooter({ text: RODAPE })],
      });
      return;
    }
    const ganhadorId = sorteio.participantes[Math.floor(Math.random() * sorteio.participantes.length)];
    await canal.send({
      content: `🎉 <@${ganhadorId}> é o grande ganhador do **Sorteio VIP Kabum**! Parabéns! 🎉`,
      embeds: [
        new EmbedBuilder()
          .setColor(COR.sorteio)
          .setTitle('🏆 Temos um ganhador!')
          .setDescription(`O sorteio foi encerrado.\n\n🏆 Ganhador: <@${ganhadorId}>`)
          .addFields({ name: 'Total de participantes', value: `${sorteio.participantes.length}`, inline: true })
          .setFooter({ text: RODAPE })
      ],
    });
  } catch (e) { console.error('Erro ao sortear:', e.message); }
}

// ATENÇÃO: GatewayIntentBits.GuildVoiceStates adicionado para o ranking funcionar!
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (c) => {
  clientBackup = c;
  
  // Restaurar dados salvos
  await restaurarBackupSorteio(c);
  await restaurarBackupVoz(c);

  // Registro de Slash Commands
  if (cfg.deployCmds) {
    try {
      const rest = new REST().setToken(cfg.token);
      await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), {
        body: [
          comandoEscalonar.toJSON(), comandoCheater.toJSON(), comandoDevolver.toJSON(),
          comandoAvisoArmadilha.toJSON(), comandoCargosPainel.toJSON(), comandoSorteioKabum.toJSON(),
          comandoSorteioEncerrar.toJSON(), comandoSorteioStatus.toJSON(),
        ],
      });
      console.log(`Comandos registrados.`);
    } catch (err) { console.error('Falha ao registrar comandos:', err); }
  }

  console.log(`Online como ${c.user.tag}`);

  // Checa se tem sorteio pendente para encerrar
  if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) {
    sortearGanhador(c);
  }
  setInterval(() => {
    if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) sortearGanhador(c);
  }, 60 * 1000);

  // ---------- Inicialização do Ranking de Voz ----------
  const guild = c.guilds.cache.get(cfg.guildId);
  if (guild) {
    // Computa as pessoas que já estão nas calls quando o bot inicia
    guild.channels.cache.filter(ch => ch.isVoiceBased()).forEach(ch => {
      if (ch.id === guild.afkChannelId) return;
      ch.members.forEach(m => {
        if (!m.user.bot) sessoesVoz[m.id] = Date.now();
      });
    });
  }

  atualizarRanking(c);
  setInterval(() => atualizarRanking(c), 5 * 60 * 1000); // Atualiza o ranking a cada 5 minutos
  setInterval(() => enviarBackupVoz(c), 15 * 60 * 1000); // Faz backup do Json de voz a cada 15 minutos
});

// ---------- Evento de rastreio de Voz ----------
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const user = newState.member?.user;
  if (!user || user.bot) return;

  const isAfk = (state) => state.channelId === state.guild.afkChannelId;
  const inValidCallOld = oldState.channelId && !isAfk(oldState);
  const inValidCallNew = newState.channelId && !isAfk(newState);

  // Entrou em call válida
  if (!inValidCallOld && inValidCallNew) {
    sessoesVoz[user.id] = Date.now();
  } 
  // Saiu da call ou foi pro AFK
  else if (inValidCallOld && !inValidCallNew) {
    if (sessoesVoz[user.id]) {
      adicionarTempoVoz(user.id, Date.now() - sessoesVoz[user.id]);
      delete sessoesVoz[user.id];
    }
  }
});

// ---------- Escalonamento e Comandos ----------
async function escalar(i, { tipo, motivo, jogador, evidencia }) {
  const alerta = tipo === 'cheater';
  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });
  const ch = i.channel;
  const noAtendimento = ch?.parentId === cfg.catAtendimento;
  const jaEscalado = ch?.parentId === cfg.catEscalonado;

  if (ch?.type !== ChannelType.GuildText || !(noAtendimento || (alerta && jaEscalado))) {
    return negar(alerta ? 'Comando só funciona dentro de ticket.' : 'Só funciona em ticket de atendimento.');
  }

  const permitidos = [...cfg.cargosAtendimento, cfg.cargoAdm];
  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.some((r) => permitidos.includes(r.id))) {
    return negar('Você não tem permissão.', 'Acesso negado');
  }

  await i.guild.channels.fetch();
  let destino = null;
  if (noAtendimento) {
    destino = i.guild.channels.cache.get(cfg.catEscalonado);
    if (!destino) return negar('Categoria de escalonados não encontrada.');
    if (destino.children.cache.size >= 50) return negar('A categoria de escalonados está cheia.');
  }

  await i.deferReply({ flags: EPH });

  try {
    if (noAtendimento) {
      await ch.setParent(destino, { lockPermissions: false, reason: `${alerta ? 'Suspeita de cheater' : 'Escalonado'}` });
      await ch.permissionOverwrites.edit(cfg.cargoAdm, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
      if (cfg.revogar) {
        for (const id of cfg.cargosAtendimento) await ch.permissionOverwrites.edit(id, { ViewChannel: false });
      }
    }

    let embed; let conteudo;
    if (alerta) {
      embed = new EmbedBuilder().setColor(COR.alerta).setAuthor(autor(i, 'Sinalizado por')).setTitle('🚨 Suspeita de cheater').setDescription('Suspeita sinalizada. Atenção prioritária.')
        .addFields({ name: 'Jogador suspeito', value: `**${jogador}**`, inline: true }, { name: 'Status', value: 'Aguardando verificação', inline: true }, { name: 'Motivo', value: citar(motivo) });
      if (evidencia) embed.addFields({ name: 'Evidências', value: evidencia });
      conteudo = `<@&${cfg.cargoAdm}> 🚨 **ALERTA:** suspeita de cheater.`;
    } else {
      embed = new EmbedBuilder().setColor(COR.escalonado).setAuthor(autor(i, 'Escalonado por')).setTitle('Ticket escalonado').addFields({ name: 'Motivo', value: citar(motivo) });
      conteudo = `<@&${cfg.cargoAdm}> novo ticket escalonado.`;
    }

    await ch.send({ content: conteudo, embeds: [embed], allowedMentions: { roles: [cfg.cargoAdm] } });

    if (alerta && cfg.alertaChannel) {
      await enviarEm(i.guild, cfg.alertaChannel, {
        content: `<@&${cfg.cargoAdm}> 🚨 cheater ticket: ${ch}`,
        embeds: [EmbedBuilder.from(embed).addFields({ name: 'Ticket', value: `${ch}` })],
        allowedMentions: { roles: [cfg.cargoAdm] },
      });
    }

    await i.editReply({ embeds: [aviso(COR.ok, alerta ? 'Alerta enviado' : 'Ticket escalonado', 'A administração foi notificada.')] });
  } catch (err) {
    console.error('Erro ao escalonar/cheater:', err);
    await i.editReply({ embeds: [aviso(COR.erro, 'Falha ao processar', 'Verifique as permissões do bot nas categorias.')] });
  }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === 'escalonar') return escalar(i, { tipo: 'escalonar', motivo: i.options.getString('motivo', true) });
  if (i.commandName === 'cheater') return escalar(i, { tipo: 'cheater', jogador: i.options.getString('jogador', true), motivo: i.options.getString('motivo', true), evidencia: i.options.getString('evidencia') });
});

// ---------- Outros Comandos (/devolver, etc) ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;

  const negar = (descricao, titulo = 'Não foi possível concluir') => i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });
  const isAdmin = i.member.permissions.has('Administrator') || i.member.roles.cache.has(cfg.cargoAdm);

  if (i.commandName === 'devolver') {
    if (!isAdmin) return negar('Só a administração pode devolver tickets.', 'Acesso negado');
    if (i.channel?.parentId !== cfg.catEscalonado) return negar('Use em um ticket escalonado.');
    
    await i.deferReply({ flags: EPH });
    try {
      const destino = i.guild.channels.cache.get(cfg.catAtendimento);
      await i.channel.setParent(destino, { lockPermissions: false });
      for (const id of cfg.cargosAtendimento) await i.channel.permissionOverwrites.edit(id, { ViewChannel: true, SendMessages: true });
      await i.channel.send(`Ticket devolvido ao atendimento. Motivo: ${i.options.getString('motivo', true)}`);
      await i.editReply({ embeds: [aviso(COR.ok, 'Ticket devolvido', 'Voltou para a categoria de atendimento.')] });
    } catch (err) { await i.editReply({ embeds: [aviso(COR.erro, 'Falha', 'Erro ao mover canal.')] }); }
  }

  if (i.commandName === 'sorteiovipkabum') {
    if (!isAdmin) return negar('Só a administração pode usar.', 'Acesso negado');
    if (sorteio && !sorteio.sorteado) return negar('Já existe um sorteio ativo.');
    
    const dias = i.options.getInteger('dias') ?? 3;
    const encerraEm = Date.now() + dias * 24 * 60 * 60 * 1000;
    const tsSegundos = Math.floor(encerraEm / 1000);

    const embed = new EmbedBuilder().setColor(COR.sorteio).setTitle('🎉 SORTEIO VIP KABUM 🎉')
      .setDescription('Sorteando R$500,00 em vale-presente Kabum.')
      .addFields({ name: 'Encerramento', value: `<t:${tsSegundos}:F> (<t:${tsSegundos}:R>)` });

    const msg = await i.channel.send({ content: '@everyone 🎉', embeds: [embed], components: [linhaBotaoSorteio()], allowedMentions: { parse: ['everyone'] } });
    sorteio = { messageId: msg.id, channelId: msg.channelId, participantes: [], encerraEm, sorteado: false };
    salvarSorteio(sorteio);
    await i.reply({ content: 'Sorteio publicado.', flags: EPH });
  }

  if (i.commandName === 'sorteio-encerrar') {
    if (!isAdmin) return negar('Sem permissão.');
    await i.reply({ content: 'Encerrando...', flags: EPH });
    sortearGanhador(i.client);
  }

  if (i.commandName === 'sorteio-status') {
    if (!isAdmin) return negar('Sem permissão.');
    if (!sorteio) return negar('Sem sorteios.');
    await i.reply({ content: `Participantes: ${sorteio.participantes.length}`, flags: EPH });
  }

  if (i.commandName === 'cargos-painel') {
    if (!isAdmin) return negar('Sem permissão.');
    await i.channel.send({ embeds: [aviso(COR.ok, '🎟️ Escolha seus cargos', 'Clique nos botões.')], components: linhasBotoesCargos() });
    await i.reply({ content: 'Painel enviado.', flags: EPH });
  }
});

// ---------- Interações em Botões ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  if (i.customId === PREFIXO_BOTAO_SORTEIO) {
    if (!i.member.roles.cache.some(r => CARGOS_PODEM_PARTICIPAR.includes(r.id) || r.id === cfg.cargoAdm)) {
      return i.reply({ content: '🚫 Você não possui cargo liberado para participar.', flags: EPH });
    }
    if (!sorteio || sorteio.sorteado || Date.now() >= sorteio.encerraEm) return i.reply({ content: 'Sorteio encerrado.', flags: EPH });
    if (sorteio.participantes.includes(i.user.id)) return i.reply({ content: '✅ Você já está participando!', flags: EPH });
    
    sorteio.participantes.push(i.user.id);
    salvarSorteio(sorteio);
    await i.reply({ content: `✅ Participando! (${sorteio.participantes.length} na lista)`, flags: EPH });
  }

  if (i.customId.startsWith(PREFIXO_BOTAO_CARGO)) {
    const cargoId = i.customId.slice(PREFIXO_BOTAO_CARGO.length);
    const cargo = CARGOS_PAINEL.find(c => c.id === cargoId);
    if (!cargo) return;
    try {
      if (i.member.roles.cache.has(cargoId)) {
        await i.member.roles.remove(cargoId);
        await i.reply({ content: `➖ Cargo **${cargo.label}** removido.`, flags: EPH });
      } else {
        await i.member.roles.add(cargoId);
        await i.reply({ content: `✅ Cargo **${cargo.label}** adicionado.`, flags: EPH });
      }
    } catch { await i.reply({ content: 'Falha ao alterar cargo.', flags: EPH }); }
  }
});

// Armadilha
if (cfg.canalCastigo) {
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.channelId !== cfg.canalCastigo || msg.author.bot) return;
    const membro = msg.member;
    if (membro?.permissions.has('Administrator')) return;
    try {
      await msg.delete().catch(() => {});
      await membro.timeout(Math.min(cfg.castigoDias * 24 * 60 * 60 * 1000, 28 * 24 * 60 * 60 * 1000), 'Armadilha');
    } catch {}
  });
}

if (process.env.PORT) require('http').createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(process.env.PORT);

console.log('Conectando ao Discord...');
client.login(cfg.token).catch((e) => console.error('Falha no login:', e));
