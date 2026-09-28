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
} = require('discord.js');

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
  revogar: (env.REVOGAR_ACESSO_ATENDIMENTO ?? 'true') === 'true',
};

for (const k of ['token', 'clientId', 'guildId', 'catAtendimento', 'catEscalonado', 'cargoAdm']) {
  if (!cfg[k]) {
    console.error(`Variável de ambiente ausente para "${k}". Confira o .env`);
    process.exit(1);
  }
}

// ---------- Identidade visual ----------
const COR = { escalonado: 0xf59e0b, devolvido: 0x22c55e, ok: 0x3b82f6, erro: 0xef4444 };
const RODAPE = 'Caveiras • Sistema de Tickets';
const citar = (texto) => `>>> ${texto}`;
const EPH = MessageFlags.Ephemeral;

const aviso = (cor, titulo, descricao) =>
  new EmbedBuilder().setColor(cor).setTitle(titulo).setDescription(descricao);

const autor = (i, prefixo) => ({
  name: `${prefixo} ${i.member?.displayName ?? i.user.username}`,
  iconURL: i.user.displayAvatarURL(),
});

async function registrar(guild, embed) {
  if (!cfg.logChannel) return;
  const canal = guild.channels.cache.get(cfg.logChannel);
  await canal?.send({ embeds: [embed] }).catch((e) => console.error('Falha no log:', e.message));
}

// ---------- Comandos ----------
const comando = new SlashCommandBuilder()
  .setName('escalonar')
  .setDescription('Escalona este ticket para a administração')
  .addStringOption((o) =>
    o
      .setName('motivo')
      .setDescription('Motivo do escalonamento')
      .setMaxLength(500)
      .setRequired(true),
  )
  .setDMPermission(false);

const comandoDevolver = new SlashCommandBuilder()
  .setName('devolver')
  .setDescription('Devolve este ticket para a categoria de atendimento (só ADM)')
  .addStringOption((o) =>
    o
      .setName('motivo')
      .setDescription('Motivo da devolução ao atendimento')
      .setMaxLength(500)
      .setRequired(true),
  )
  .setDMPermission(false);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), {
    body: [comando.toJSON(), comandoDevolver.toJSON()],
  });
  console.log(`Online como ${c.user.tag} — /escalonar e /devolver registrados.`);
});

// ---------- /escalonar ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'escalonar') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });
  const ch = i.channel;

  // 1) Precisa ser um ticket na categoria de atendimento
  if (ch?.type !== ChannelType.GuildText || ch.parentId !== cfg.catAtendimento) {
    return negar('Este comando só funciona dentro de um ticket da categoria de atendimento.');
  }

  // 2) Só Recrutador/Moderador/ADM
  const permitidos = [...cfg.cargosAtendimento, cfg.cargoAdm];
  if (
    !i.member.permissions.has('Administrator') &&
    !i.member.roles.cache.some((r) => permitidos.includes(r.id))
  ) {
    console.log(
      `[perm] negado para ${i.user.tag} | cargos do usuário: ${[...i.member.roles.cache.keys()].join(',')} | permitidos: ${permitidos.join(',')}`,
    );
    return negar('Você não tem permissão para escalonar tickets.', 'Acesso negado');
  }

  // 3) Categoria de destino
  await i.guild.channels.fetch();
  const destino = i.guild.channels.cache.get(cfg.catEscalonado);
  if (!destino || destino.type !== ChannelType.GuildCategory) {
    return negar('Categoria de escalonados não encontrada. Avise um ADM.');
  }
  if (destino.children.cache.size >= 50) {
    return negar('A categoria de escalonados está cheia (limite de 50 canais do Discord).');
  }

  await i.deferReply({ flags: EPH });
  const motivo = i.options.getString('motivo', true);

  try {
    // Move sem sincronizar (preserva o acesso de quem abriu o ticket)
    await ch.setParent(destino, {
      lockPermissions: false,
      reason: `Escalonado por ${i.user.tag}`,
    });

    // ADM passa a ver e responder
    await ch.permissionOverwrites.edit(cfg.cargoAdm, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });

    // Atendimento perde acesso (se REVOGAR_ACESSO_ATENDIMENTO=true)
    if (cfg.revogar) {
      for (const id of cfg.cargosAtendimento) {
        await ch.permissionOverwrites.edit(id, { ViewChannel: false });
      }
    }

    const embed = new EmbedBuilder()
      .setColor(COR.escalonado)
      .setAuthor(autor(i, 'Escalonado por'))
      .setTitle('Ticket escalonado')
      .setDescription('Este atendimento foi encaminhado à administração para análise.')
      .addFields(
        { name: 'Motivo', value: citar(motivo) },
        { name: 'Status', value: 'Aguardando administração', inline: true },
      )
      .setFooter({ text: RODAPE })
      .setTimestamp();

    await ch.send({
      content: `<@&${cfg.cargoAdm}> novo ticket escalonado aguardando análise.`,
      embeds: [embed],
      allowedMentions: { roles: [cfg.cargoAdm] },
    });

    await registrar(
      i.guild,
      new EmbedBuilder()
        .setColor(COR.escalonado)
        .setTitle('Registro • Escalonamento')
        .addFields(
          { name: 'Ticket', value: `${ch}\n\`#${ch.name}\``, inline: true },
          { name: 'Responsável', value: `${i.user}`, inline: true },
          { name: 'Motivo', value: citar(motivo) },
        )
        .setFooter({ text: RODAPE })
        .setTimestamp(),
    );

    await i.editReply({
      embeds: [aviso(COR.ok, 'Ticket escalonado', 'O ticket foi encaminhado à administração.')],
    });
  } catch (err) {
    console.error('Erro ao escalonar:', err);
    await i.editReply({
      embeds: [
        aviso(COR.erro, 'Falha ao escalonar', 'Verifique as permissões do bot nas duas categorias.'),
      ],
    });
  }
});

// ---------- /devolver ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'devolver') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });
  const ch = i.channel;

  // 1) Só ADM
  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode devolver tickets.', 'Acesso negado');
  }

  // 2) Precisa estar na categoria de escalonados
  if (ch?.type !== ChannelType.GuildText || ch.parentId !== cfg.catEscalonado) {
    return negar('Este comando só funciona dentro de um ticket da categoria de escalonados.');
  }

  // 3) Categoria de destino (atendimento)
  await i.guild.channels.fetch();
  const destino = i.guild.channels.cache.get(cfg.catAtendimento);
  if (!destino || destino.type !== ChannelType.GuildCategory) {
    return negar('Categoria de atendimento não encontrada. Confira o .env.');
  }
  if (destino.children.cache.size >= 50) {
    return negar('A categoria de atendimento está cheia (limite de 50 canais do Discord).');
  }

  await i.deferReply({ flags: EPH });
  const motivo = i.options.getString('motivo', true);

  try {
    await ch.setParent(destino, {
      lockPermissions: false,
      reason: `Devolvido por ${i.user.tag}`,
    });

    // Recrutador/Moderador voltam a ver e responder
    for (const id of cfg.cargosAtendimento) {
      await ch.permissionOverwrites.edit(id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    }

    const embed = new EmbedBuilder()
      .setColor(COR.devolvido)
      .setAuthor(autor(i, 'Devolvido por'))
      .setTitle('Ticket devolvido ao atendimento')
      .setDescription('A administração devolveu este ticket para continuidade do atendimento.')
      .addFields(
        { name: 'Motivo', value: citar(motivo) },
        { name: 'Status', value: 'Em atendimento', inline: true },
      )
      .setFooter({ text: RODAPE })
      .setTimestamp();

    const mencoes = cfg.cargosAtendimento.map((id) => `<@&${id}>`).join(' ');
    await ch.send({
      content: `${mencoes} ticket devolvido ao atendimento.`.trim(),
      embeds: [embed],
      allowedMentions: { roles: cfg.cargosAtendimento },
    });

    await registrar(
      i.guild,
      new EmbedBuilder()
        .setColor(COR.devolvido)
        .setTitle('Registro • Devolução')
        .addFields(
          { name: 'Ticket', value: `${ch}\n\`#${ch.name}\``, inline: true },
          { name: 'Responsável', value: `${i.user}`, inline: true },
          { name: 'Motivo', value: citar(motivo) },
        )
        .setFooter({ text: RODAPE })
        .setTimestamp(),
    );

    await i.editReply({
      embeds: [aviso(COR.ok, 'Ticket devolvido', 'O ticket voltou para a categoria de atendimento.')],
    });
  } catch (err) {
    console.error('Erro ao devolver:', err);
    await i.editReply({
      embeds: [
        aviso(COR.erro, 'Falha ao devolver', 'Verifique as permissões do bot nas duas categorias.'),
      ],
    });
  }
});

// Servidor HTTP mínimo: só sobe onde há PORT definida (ex.: Web Service do Render)
if (process.env.PORT) {
  require('http')
    .createServer((_, res) => {
      res.writeHead(200);
      res.end('ok');
    })
    .listen(process.env.PORT, () => console.log(`HTTP na porta ${process.env.PORT}`));
}

// Diagnóstico
client.on(Events.Error, (e) => console.error('client error:', e));
client.on(Events.ShardError, (e) => console.error('shard error:', e));
client.on(Events.Warn, (m) => console.warn('warn:', m));
if (process.env.DEBUG_DISCORD === 'true') client.on(Events.Debug, (m) => console.log('[debug]', m));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

console.log(`[diag] token com ${cfg.token.length} caracteres`);
(async () => {
  try {
    const r = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${cfg.token}` },
    });
    const corpo = (await r.text()).replace(/\s+/g, ' ').slice(0, 150);
    console.log(`[diag] Discord API respondeu ${r.status}: ${corpo}`);
  } catch (e) {
    console.error('[diag] não alcançou a API do Discord:', e.message);
  }
})();
const pendente = setTimeout(() => console.warn('[diag] login ainda pendente após 30s'), 30000);
client.once(Events.ClientReady, () => clearTimeout(pendente));

console.log('Conectando ao Discord...');
client.login(cfg.token).catch((e) => console.error('Falha no login:', e));
