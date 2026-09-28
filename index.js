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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), {
    body: [comando.toJSON()],
  });
  console.log(`Online como ${c.user.tag} — /escalonar registrado.`);
});

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'escalonar') return;

  const negar = (content) => i.reply({ content, flags: MessageFlags.Ephemeral });
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
    return negar('Você não tem permissão para escalonar tickets.');
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

  await i.deferReply({ flags: MessageFlags.Ephemeral });
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
      .setColor(0xe67e22)
      .setTitle('Ticket escalonado')
      .addFields(
        { name: 'Escalonado por', value: `${i.user}`, inline: true },
        { name: 'Motivo', value: motivo },
      )
      .setTimestamp();

    await ch.send({
      content: `<@&${cfg.cargoAdm}> este ticket foi escalonado para a administração.`,
      embeds: [embed],
      allowedMentions: { roles: [cfg.cargoAdm] },
    });

    if (cfg.logChannel) {
      const log = i.guild.channels.cache.get(cfg.logChannel);
      await log?.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0xe67e22)
            .setTitle('Escalonamento')
            .addFields(
              { name: 'Ticket', value: `${ch} (${ch.name})`, inline: true },
              { name: 'Por', value: `${i.user}`, inline: true },
              { name: 'Motivo', value: motivo ?? '—' },
            )
            .setTimestamp(),
        ],
      });
    }

    await i.editReply('Ticket escalonado para a administração.');
  } catch (err) {
    console.error('Erro ao escalonar:', err);
    await i.editReply('Falha ao escalonar. Verifique as permissões do bot nas duas categorias.');
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
