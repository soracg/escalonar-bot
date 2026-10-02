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
};
const RODAPE = 'Caveiras • Sistema de Tickets';
const citar = (texto) => `>>> ${texto}`;
const EPH = MessageFlags.Ephemeral;

const aviso = (cor, titulo, descricao) =>
  new EmbedBuilder().setColor(cor).setTitle(titulo).setDescription(descricao);

const autor = (i, prefixo) => ({
  name: `${prefixo} ${i.member?.displayName ?? i.user.username}`,
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
  .addStringOption((o) =>
    o
      .setName('motivo')
      .setDescription('Motivo do escalonamento')
      .setMaxLength(500)
      .setRequired(true),
  )
  .setDMPermission(false);

const comandoCheater = new SlashCommandBuilder()
  .setName('cheater')
  .setDescription('Sinaliza suspeita de cheater e escalona o ticket com prioridade')
  .addStringOption((o) =>
    o
      .setName('jogador')
      .setDescription('Nick ou ID do jogador suspeito')
      .setMaxLength(100)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName('motivo')
      .setDescription('O que motivou a suspeita')
      .setMaxLength(500)
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName('evidencia')
      .setDescription('Link de vídeo/print ou descrição da prova, se houver')
      .setMaxLength(300),
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

const comandoSorteioKabum = new SlashCommandBuilder()
  .setName('sorteiovipkabum')
  .setDescription('Anuncia o sorteio de R$500 em vale-presente da Kabum (só ADM)')
  .addIntegerOption((o) =>
    o
      .setName('dias')
      .setDescription('Duração do sorteio em dias (padrão: 3)')
      .setMinValue(1)
      .setMaxValue(30),
  )
  .setDMPermission(false);

const comandoSorteioEncerrar = new SlashCommandBuilder()
  .setName('sorteio-encerrar')
  .setDescription('Encerra o sorteio ativo agora e sorteia o ganhador (só ADM)')
  .setDMPermission(false);

const comandoSorteioStatus = new SlashCommandBuilder()
  .setName('sorteio-status')
  .setDescription('Mostra quem está participando do sorteio ativo (só ADM)')
  .setDMPermission(false);

// ---------- Persistência simples do sorteio (sobrevive a reinícios) ----------
const DADOS_SORTEIO = path.join(__dirname, 'data', 'sorteio.json');
const PREFIXO_BOTAO_SORTEIO = 'sorteio_participar';

// Cargos autorizados a participar do sorteio
const CARGOS_PODEM_PARTICIPAR = [
  '1400511336437514452', // Membro Efetivo
  '1401000578372604028', // Recruta
  '1404521279775834184', // Moderador
  '409442142667145247', // ADM (confira este ID)
  '1401534428416708779', // Recrutador
  '1419044618711994510', // Dev
];

function carregarSorteio() {
  try {
    return JSON.parse(fs.readFileSync(DADOS_SORTEIO, 'utf8'));
  } catch {
    return null;
  }
}
function salvarSorteio(s) {
  try {
    fs.mkdirSync(path.dirname(DADOS_SORTEIO), { recursive: true });
    fs.writeFileSync(DADOS_SORTEIO, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('Falha ao salvar dados do sorteio:', e.message);
  }
}
let sorteio = carregarSorteio(); // { messageId, channelId, participantes: [], encerraEm, sorteado }

function linhaBotaoSorteio(desativado = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PREFIXO_BOTAO_SORTEIO)
      .setLabel('Participar')
      .setEmoji('🎟️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(desativado),
  );
}

async function sortearGanhador(client) {
  if (!sorteio || sorteio.sorteado) return;
  sorteio.sorteado = true;
  salvarSorteio(sorteio);

  try {
    const canal = await client.channels.fetch(sorteio.channelId).catch(() => null);
    if (!canal) return;

    // Desativa o botão na mensagem original
    const msgOriginal = await canal.messages.fetch(sorteio.messageId).catch(() => null);
    if (msgOriginal) {
      await msgOriginal.edit({ components: [linhaBotaoSorteio(true)] }).catch(() => {});
    }

    if (sorteio.participantes.length === 0) {
      await canal.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COR.erro)
            .setTitle('🎉 Sorteio VIP Kabum encerrado')
            .setDescription('O prazo de inscrições acabou e **ninguém participou** desta vez. 😢')
            .setFooter({ text: RODAPE })
            .setTimestamp(),
        ],
      });
      return;
    }

    const ganhadorId =
      sorteio.participantes[Math.floor(Math.random() * sorteio.participantes.length)];

    await canal.send({
      content: `🎉 <@${ganhadorId}> é o grande ganhador do **Sorteio VIP Kabum**! Parabéns! 🎉`,
      embeds: [
        new EmbedBuilder()
          .setColor(COR.sorteio)
          .setTitle('🏆 Temos um ganhador!')
          .setDescription(
            `O sorteio de **R$500,00 em vale-presente Kabum** foi encerrado.\n\n🏆 Ganhador: <@${ganhadorId}>`,
          )
          .addFields({ name: 'Total de participantes', value: `${sorteio.participantes.length}`, inline: true })
          .setFooter({ text: RODAPE })
          .setTimestamp(),
      ],
    });
  } catch (e) {
    console.error('Erro ao sortear ganhador:', e.message);
  }
}

const comandoCargosPainel = new SlashCommandBuilder()
  .setName('cargos-painel')
  .setDescription('Posta o painel de botões para os membros pegarem seus cargos (só ADM)')
  .setDMPermission(false);

const comandoAvisoArmadilha = new SlashCommandBuilder()
  .setName('aviso-armadilha')
  .setDescription('Posta e fixa o aviso explicando o canal-armadilha (só ADM)')
  .setDMPermission(false);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, async (c) => {
  const rest = new REST().setToken(cfg.token);
  await rest.put(Routes.applicationGuildCommands(cfg.clientId, cfg.guildId), {
    body: [
      comandoEscalonar.toJSON(),
      comandoCheater.toJSON(),
      comandoDevolver.toJSON(),
      comandoAvisoArmadilha.toJSON(),
      comandoCargosPainel.toJSON(),
      comandoSorteioKabum.toJSON(),
      comandoSorteioEncerrar.toJSON(),
      comandoSorteioStatus.toJSON(),
    ],
  });
  console.log(
    `Online como ${c.user.tag} — comandos registrados (escalonar, cheater, devolver, aviso-armadilha, cargos-painel, sorteiovipkabum, sorteio-encerrar, sorteio-status).`,
  );

  // Ao iniciar: se já havia um sorteio salvo e o prazo passou enquanto o bot estava offline, sorteia agora.
  if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) {
    sortearGanhador(c);
  }

  // Verifica a cada minuto se algum sorteio ativo já venceu o prazo
  setInterval(() => {
    if (sorteio && !sorteio.sorteado && Date.now() >= sorteio.encerraEm) {
      sortearGanhador(c);
    }
  }, 60 * 1000);
});

// ---------- Escalonamento (usado por /escalonar e /cheater) ----------
async function escalar(i, { tipo, motivo, jogador, evidencia }) {
  const alerta = tipo === 'cheater';
  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });
  const ch = i.channel;

  const noAtendimento = ch?.parentId === cfg.catAtendimento;
  const jaEscalado = ch?.parentId === cfg.catEscalonado;

  // 1) Precisa ser um ticket (o /cheater também vale em ticket já escalonado)
  if (ch?.type !== ChannelType.GuildText || !(noAtendimento || (alerta && jaEscalado))) {
    return negar(
      alerta
        ? 'Este comando só funciona dentro de um ticket.'
        : 'Este comando só funciona dentro de um ticket da categoria de atendimento.',
    );
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
    return negar('Você não tem permissão para usar este comando.', 'Acesso negado');
  }

  // 3) Categoria de destino (só quando o ticket ainda está no atendimento)
  await i.guild.channels.fetch();
  let destino = null;
  if (noAtendimento) {
    destino = i.guild.channels.cache.get(cfg.catEscalonado);
    if (!destino || destino.type !== ChannelType.GuildCategory) {
      return negar('Categoria de escalonados não encontrada. Avise um ADM.');
    }
    if (destino.children.cache.size >= 50) {
      return negar('A categoria de escalonados está cheia (limite de 50 canais do Discord).');
    }
  }

  await i.deferReply({ flags: EPH });

  try {
    if (noAtendimento) {
      // Move sem sincronizar (preserva o acesso de quem abriu o ticket)
      await ch.setParent(destino, {
        lockPermissions: false,
        reason: `${alerta ? 'Suspeita de cheater' : 'Escalonado'} por ${i.user.tag}`,
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
    }

    // ---- Mensagem no ticket ----
    let embed;
    let conteudo;
    if (alerta) {
      embed = new EmbedBuilder()
        .setColor(COR.alerta)
        .setAuthor(autor(i, 'Sinalizado por'))
        .setTitle('🚨 Suspeita de cheater')
        .setDescription(
          'Suspeita de cheater sinalizada neste ticket. Requer atenção prioritária da administração.',
        )
        .addFields(
          { name: 'Jogador suspeito', value: `**${jogador}**`, inline: true },
          { name: 'Prioridade', value: 'Alta', inline: true },
          { name: 'Status', value: 'Suspeita — aguardando verificação', inline: true },
          { name: 'Motivo da suspeita', value: citar(motivo) },
        )
        .setFooter({ text: RODAPE })
        .setTimestamp();
      if (evidencia) embed.addFields({ name: 'Evidências', value: evidencia });
      conteudo = `<@&${cfg.cargoAdm}> 🚨 **ALERTA:** suspeita de cheater sinalizada neste ticket.`;
    } else {
      embed = new EmbedBuilder()
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
      conteudo = `<@&${cfg.cargoAdm}> novo ticket escalonado aguardando análise.`;
    }

    await ch.send({
      content: conteudo,
      embeds: [embed],
      allowedMentions: { roles: [cfg.cargoAdm] },
    });

    // ---- Alerta no canal dedicado (só /cheater, se configurado) ----
    if (alerta && cfg.alertaChannel) {
      await enviarEm(i.guild, cfg.alertaChannel, {
        content: `<@&${cfg.cargoAdm}> 🚨 suspeita de cheater — ticket: ${ch}`,
        embeds: [EmbedBuilder.from(embed).addFields({ name: 'Ticket', value: `${ch}`, inline: true })],
        allowedMentions: { roles: [cfg.cargoAdm] },
      });
    }

    // ---- Registro ----
    const log = new EmbedBuilder()
      .setColor(alerta ? COR.alerta : COR.escalonado)
      .setTitle(alerta ? 'Registro • Suspeita de cheater' : 'Registro • Escalonamento')
      .addFields(
        { name: 'Ticket', value: `${ch}\n\`#${ch.name}\``, inline: true },
        { name: 'Responsável', value: `${i.user}`, inline: true },
      )
      .setFooter({ text: RODAPE })
      .setTimestamp();
    if (alerta) log.addFields({ name: 'Jogador suspeito', value: jogador, inline: true });
    log.addFields({ name: 'Motivo', value: citar(motivo) });
    if (alerta && evidencia) log.addFields({ name: 'Evidências', value: evidencia });
    await enviarEm(i.guild, cfg.logChannel, { embeds: [log] });

    await i.editReply({
      embeds: [
        aviso(
          COR.ok,
          alerta ? 'Alerta enviado' : 'Ticket escalonado',
          alerta
            ? 'A administração foi notificada sobre a suspeita de cheater.'
            : 'O ticket foi encaminhado à administração.',
        ),
      ],
    });
  } catch (err) {
    console.error(`Erro ao ${alerta ? 'sinalizar cheater' : 'escalonar'}:`, err);
    await i.editReply({
      embeds: [
        aviso(
          COR.erro,
          alerta ? 'Falha ao sinalizar' : 'Falha ao escalonar',
          'Verifique as permissões do bot nas duas categorias.',
        ),
      ],
    });
  }
}

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === 'escalonar') {
    return escalar(i, { tipo: 'escalonar', motivo: i.options.getString('motivo', true) });
  }
  if (i.commandName === 'cheater') {
    return escalar(i, {
      tipo: 'cheater',
      jogador: i.options.getString('jogador', true),
      motivo: i.options.getString('motivo', true),
      evidencia: i.options.getString('evidencia'),
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

    await enviarEm(i.guild, cfg.logChannel, {
      embeds: [
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
      ],
    });

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

// ---------- /sorteiovipkabum ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'sorteiovipkabum') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });

  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode usar este comando.', 'Acesso negado');
  }
  if (sorteio && !sorteio.sorteado) {
    return negar(
      'Já existe um sorteio em andamento. Use /sorteio-encerrar para finalizá-lo antes de abrir outro.',
    );
  }

  const dias = i.options.getInteger('dias') ?? 3;
  const encerraEm = Date.now() + dias * 24 * 60 * 60 * 1000;
  const tsSegundos = Math.floor(encerraEm / 1000);

  const embedSorteio = new EmbedBuilder()
    .setColor(COR.sorteio)
    .setTitle('🎉 SORTEIO VIP • R$500 EM VALE-PRESENTE KABUM! 🎉')
    .setDescription(
      '**Chegou a sua chance de turbinar o setup de graça!**\n\n' +
        'A Caveiras está sorteando **R$500,00 em vale-presente da Kabum** para um membro da nossa comunidade. ' +
        'Pode ser aquele periférico novo, upgrade na máquina ou o que você quiser — o prêmio é todo seu!',
    )
    .addFields(
      { name: '💰 Prêmio', value: 'R$500,00 em vale-presente Kabum', inline: true },
      { name: '🍀 Quem pode participar', value: 'Todos os membros da Caveiras', inline: true },
      {
        name: '📋 Como participar',
        value: citar('Clique no botão **🎟️ Participar** abaixo. É só isso!'),
      },
      { name: '⏰ Encerramento', value: `<t:${tsSegundos}:F> (<t:${tsSegundos}:R>)` },
      { name: '🔥 Dica', value: 'Convide seus amigos para o servidor — quanto mais gente, mais animado fica!' },
    )
    .setImage('attachment://sorteio-kabum.jpeg')
    .setFooter({ text: RODAPE })
    .setTimestamp();

  try {
    const imagem = new AttachmentBuilder(
      path.join(__dirname, 'assets', 'sorteio-kabum.jpeg'),
      { name: 'sorteio-kabum.jpeg' },
    );
    const msg = await i.channel.send({
      content: '@everyone 🎉 **SORTEIO VIP KABUM** está no ar! Não fique de fora! 🎉',
      embeds: [embedSorteio],
      files: [imagem],
      components: [linhaBotaoSorteio()],
      allowedMentions: { parse: ['everyone'] },
    });

    sorteio = {
      messageId: msg.id,
      channelId: msg.channelId,
      participantes: [],
      encerraEm,
      sorteado: false,
    };
    salvarSorteio(sorteio);

    await i.reply({
      embeds: [
        aviso(
          COR.ok,
          'Sorteio publicado',
          `O anúncio foi postado neste canal e encerra em ${dias} dia(s).`,
        ),
      ],
      flags: EPH,
    });
  } catch (err) {
    console.error('Erro ao postar sorteio:', err);
    await negar('Verifique as permissões do bot neste canal.', 'Falha ao publicar');
  }
});

// ---------- Botão "Participar" do sorteio ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || i.customId !== PREFIXO_BOTAO_SORTEIO) return;

  // Trava: só quem tem um dos cargos liberados pode participar
  const podeParticipar =
    i.member?.roles?.cache?.some(
      (r) => CARGOS_PODEM_PARTICIPAR.includes(r.id) || r.id === cfg.cargoAdm,
    ) ?? false;
  if (!podeParticipar) {
    return i.reply({
      content: '🚫 Só membros com cargo liberado (Membro Efetivo, Recruta, Moderador, ADM, Recrutador ou Dev) podem participar deste sorteio.',
      flags: EPH,
    });
  }

  if (!sorteio || sorteio.sorteado) {
    return i.reply({ content: 'Não há nenhum sorteio ativo no momento.', flags: EPH });
  }
  if (Date.now() >= sorteio.encerraEm) {
    return i.reply({ content: 'As inscrições já encerraram. Aguarde o resultado!', flags: EPH });
  }
  if (sorteio.participantes.includes(i.user.id)) {
    return i.reply({ content: '✅ Você já está participando! Boa sorte 🍀', flags: EPH });
  }

  sorteio.participantes.push(i.user.id);
  salvarSorteio(sorteio);

  console.log(
    `[sorteio] +1 participante: ${i.user.tag} (${i.user.id}) — total agora: ${sorteio.participantes.length}`,
  );

  await i.reply({
    content: `✅ Você está participando do **Sorteio VIP Kabum**! Boa sorte 🍀 (${sorteio.participantes.length} participante(s) até agora)`,
    flags: EPH,
  });
});

// ---------- /sorteio-status ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'sorteio-status') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });

  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode usar este comando.', 'Acesso negado');
  }
  if (!sorteio) {
    return negar('Nenhum sorteio foi iniciado ainda.');
  }

  const lista =
    sorteio.participantes.length > 0
      ? sorteio.participantes.map((id, idx) => `${idx + 1}. <@${id}> (\`${id}\`)`).join('\n')
      : '_Ninguém participou ainda._';

  const tsSegundos = Math.floor(sorteio.encerraEm / 1000);

  await i.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COR.sorteio)
        .setTitle('🎟️ Status do sorteio')
        .addFields(
          { name: 'Status', value: sorteio.sorteado ? 'Encerrado' : 'Em andamento', inline: true },
          { name: 'Total de participantes', value: `${sorteio.participantes.length}`, inline: true },
          { name: 'Encerramento', value: `<t:${tsSegundos}:F> (<t:${tsSegundos}:R>)` },
          { name: 'Participantes', value: lista.slice(0, 1024) },
        )
        .setFooter({ text: RODAPE })
        .setTimestamp(),
    ],
    flags: EPH,
  });
});

// ---------- /sorteio-encerrar ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'sorteio-encerrar') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });

  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode usar este comando.', 'Acesso negado');
  }
  if (!sorteio || sorteio.sorteado) {
    return negar('Não há nenhum sorteio ativo no momento.');
  }

  await i.reply({
    embeds: [aviso(COR.ok, 'Encerrando sorteio', 'O resultado será anunciado no canal do sorteio.')],
    flags: EPH,
  });
  await sortearGanhador(i.client);
});

// ---------- /cargos-painel ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'cargos-painel') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });

  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode usar este comando.', 'Acesso negado');
  }

  const embedPainel = new EmbedBuilder()
    .setColor(COR.ok)
    .setTitle('🎟️ Escolha seus cargos')
    .setDescription(
      'Clique nos botões abaixo para pegar ou remover um cargo. Use para liberar acesso aos canais e marcações de eventos, jogos e divisões.',
    )
    .addFields({
      name: 'Cargos disponíveis',
      value: CARGOS_PAINEL.map((c) => `• ${c.label}`).join('\n'),
    })
    .setFooter({ text: RODAPE })
    .setTimestamp();

  try {
    await i.channel.send({ embeds: [embedPainel], components: linhasBotoesCargos() });
    await i.reply({
      embeds: [aviso(COR.ok, 'Painel publicado', 'O painel de cargos foi postado neste canal.')],
      flags: EPH,
    });
  } catch (err) {
    console.error('Erro ao postar painel de cargos:', err);
    await negar('Verifique as permissões do bot neste canal.', 'Falha ao publicar');
  }
});

// ---------- Botões de cargo ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton() || !i.customId.startsWith(PREFIXO_BOTAO_CARGO)) return;

  const cargoId = i.customId.slice(PREFIXO_BOTAO_CARGO.length);
  const cargo = CARGOS_PAINEL.find((c) => c.id === cargoId);
  if (!cargo) return i.reply({ content: 'Cargo não reconhecido.', flags: EPH });

  try {
    const tem = i.member.roles.cache.has(cargoId);
    if (tem) {
      await i.member.roles.remove(cargoId, 'Autosserviço: botão de cargos');
      await i.reply({ content: `➖ Cargo **${cargo.label}** removido.`, flags: EPH });
    } else {
      await i.member.roles.add(cargoId, 'Autosserviço: botão de cargos');
      await i.reply({ content: `✅ Cargo **${cargo.label}** adicionado.`, flags: EPH });
    }
  } catch (err) {
    console.error('Erro ao alternar cargo:', err);
    await i.reply({
      content: 'Não consegui alterar esse cargo. Avise um ADM (pode ser permissão do bot).',
      flags: EPH,
    });
  }
});

// ---------- /aviso-armadilha ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'aviso-armadilha') return;

  const negar = (descricao, titulo = 'Não foi possível concluir') =>
    i.reply({ embeds: [aviso(COR.erro, titulo, descricao)], flags: EPH });

  if (!i.member.permissions.has('Administrator') && !i.member.roles.cache.has(cfg.cargoAdm)) {
    return negar('Só a administração pode usar este comando.', 'Acesso negado');
  }
  if (!cfg.canalCastigo) {
    return negar('CANAL_CASTIGO_ID não está configurado. Avise um ADM.');
  }
  if (i.channelId !== cfg.canalCastigo) {
    return negar('Use este comando dentro do canal-armadilha.');
  }

  await i.deferReply({ flags: EPH });

  const embedAviso = new EmbedBuilder()
    .setColor(COR.alerta)
    .setTitle('⚠️ Não envie mensagens neste canal')
    .setDescription(
      'Este canal é monitorado e **não deve receber mensagens**. Ele existe para identificar contas comprometidas (hackeadas) que enviam links maliciosos no servidor.',
    )
    .addFields(
      {
        name: 'O que acontece se alguém postar aqui',
        value: 'A mensagem é apagada automaticamente e o autor recebe castigo (timeout) imediato.',
      },
      {
        name: 'Minha conta foi punida por engano?',
        value: 'Se sua conta foi hackeada e postou aqui sem sua ação, procure a administração em um ticket assim que recuperar o acesso.',
      },
    )
    .setFooter({ text: RODAPE })
    .setTimestamp();

  try {
    const msg = await i.channel.send({ embeds: [embedAviso] });
    await msg.pin().catch(() => {});
    await i.editReply({
      embeds: [aviso(COR.ok, 'Aviso publicado', 'O aviso foi postado e fixado no canal-armadilha.')],
    });
  } catch (err) {
    console.error('Erro ao postar aviso da armadilha:', err);
    await i.editReply({
      embeds: [aviso(COR.erro, 'Falha ao publicar', 'Verifique as permissões do bot neste canal.')],
    });
  }
});

// ---------- Canal-armadilha (contas hackeadas postando links) ----------
if (cfg.canalCastigo) {
  const MS_DIA = 24 * 60 * 60 * 1000;
  const MAX_TIMEOUT = 28 * MS_DIA; // limite do Discord
  const duracao = Math.min(cfg.castigoDias * MS_DIA, MAX_TIMEOUT);

  client.on(Events.MessageCreate, async (msg) => {
    if (!msg.guild || msg.channelId !== cfg.canalCastigo) return;
    if (msg.author.bot) return;

    const membro = msg.member ?? (await msg.guild.members.fetch(msg.author.id).catch(() => null));
    if (!membro) return;

    // Isenta ADM — mensagem legítima da administração não deve ser punida
    if (membro.permissions.has('Administrator') || membro.roles.cache.has(cfg.cargoAdm)) return;

    try {
      await msg.delete().catch(() => {});
      await membro.timeout(
        duracao,
        `Mensagem em canal-armadilha (possível conta comprometida) — ${cfg.castigoDias}d`,
      );

      console.log(`[castigo] ${msg.author.tag} (${msg.author.id}) mutado por ${cfg.castigoDias}d — canal-armadilha`);

      await enviarEm(msg.guild, cfg.castigoAlertaChannel, {
        content: `<@&${cfg.cargoAdm}> 🚨 possível conta comprometida detectada no canal-armadilha.`,
        embeds: [
          new EmbedBuilder()
            .setColor(COR.alerta)
            .setTitle('🚨 Registro • Canal-armadilha')
            .setDescription(
              'Mensagem detectada no canal-armadilha. Possível conta comprometida enviando links maliciosos.',
            )
            .addFields(
              { name: 'Usuário', value: `${msg.author} (\`${msg.author.id}\`)`, inline: true },
              { name: 'Castigo aplicado', value: `${cfg.castigoDias} dia(s)`, inline: true },
            )
            .setFooter({ text: RODAPE })
            .setTimestamp(),
        ],
        allowedMentions: { roles: [cfg.cargoAdm] },
      });
    } catch (err) {
      console.error('Erro ao aplicar castigo no canal-armadilha:', err.message);
    }
  });
}

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
