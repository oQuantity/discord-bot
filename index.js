// index.js
import fs from 'fs';
import fetch from 'node-fetch';
import { Client, GatewayIntentBits, Partials, EmbedBuilder, Collection } from 'discord.js';

// Load config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Lux logo
const LUX_LOGO = 'https://cdn.discordapp.com/attachments/1466931430893551738/1473461721472565249/lux.jpg?ex=69964ba9&is=6994fa29&hm=b838bf213f15a8b7439b51b2fff52addbec6a26652bf86c8e74115f7c5656464&';

// Load users/stock data
let users = { stock: [], used: [], stats: { userCounts: {}, logs: [] }, subscriptions: [] };
if (fs.existsSync('./users.json')) users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));

// Ensure arrays exist
if (!users.stock) users.stock = [];
if (!users.used) users.used = [];
if (!users.stats) users.stats = { userCounts: {}, logs: [] };
if (!users.subscriptions) users.subscriptions = [];

// Command cooldowns
const cooldowns = new Collection();

// Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// Helper: update leaderboard
async function updateLeaderboard(channel) {
    const now = Date.now();
    const last24h = now - 24*60*60*1000;
    const logs = users.stats.logs || [];

    const lifetimeTop = Object.entries(users.stats.userCounts || {})
        .sort((a,b)=> b[1]-a[1])
        .slice(0,5)
        .map(([uid, count], i) => `${i + 1}. <@${uid}> (${count})`)
        .join('\n') || 'N/A';

    const counts24 = {};
    logs.filter(log => log.time >= last24h).forEach(log => {
        counts24[log.userId] = (counts24[log.userId] || 0) + 1;
    });
    const top24h = Object.entries(counts24)
        .sort((a,b)=> b[1]-a[1])
        .slice(0,5)
        .map(([uid,count],i)=> ${i+1}. <@${uid}> (${count}))
        .join('\n') || 'N/A';

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📊 Lux Live Leaderboard')
        .setThumbnail(LUX_LOGO)
        .addFields(
            { name: '🏆 Top Lifetime Generators', value: lifetimeTop, inline: true },
            { name: '🏆 Top 24h Generators', value: top24h, inline: true }
        )
        .setFooter({ text: 'Lux Live Leaderboard', iconURL: LUX_LOGO })
        .setTimestamp();

    const pinned = await channel.messages.fetchPinned();
    let leaderboardMessage = pinned.find(msg => msg.author.id === client.user.id && msg.embeds.length && msg.embeds[0].title.includes('Lux Live Leaderboard'));
    
    if (leaderboardMessage) {
        await leaderboardMessage.edit({ embeds: [embed] });
    } else {
        const msg = await channel.send({ embeds: [embed] });
        await msg.pin();
    }
}

// Ready
client.once('ready', async () => {
    console.log('Lux Bot is online!');

    // ===== Register slash commands =====
    const commands = [
        {
            name: 'subscribe',
            description: 'Subscribe a user',
            options: [
                { name: 'target', type: 6, description: 'User to subscribe', required: true },
                { name: 'duration', type: 4, description: 'Duration in seconds', required: false },
                { name: 'cooldown', type: 4, description: 'Cooldown in seconds', required: false }
            ]
        },
        { name: 'gen', description: 'Generate an account' },
        {
            name: 'stock',
            description: 'Upload stock file',
            options: [
                { name: 'file', type: 11, description: 'Text file with stock', required: true }
            ]
        },
        { name: 'removestock', description: 'Remove all stock' },
        { name: 'stats', description: 'View bot statistics' }
    ];

    await client.application.commands.set(commands, config.guildId);
    console.log('Slash commands registered instantly.');
});

// ===== Auto-remove expired subscriptions =====
setInterval(async () => {
    if (!users.subscriptions) users.subscriptions = [];

    const now = Date.now();
    let changed = false;

    for (let i = users.subscriptions.length - 1; i >= 0; i--) {
        const sub = users.subscriptions[i];
        if (sub.expiresAt <= now) {
            try {
                const guild = await client.guilds.fetch(config.guildId);
                const member = await guild.members.fetch(sub.userId).catch(() => null);
                if (member) {
                    await member.roles.remove(config.premiumRoleId);
                    console.log(Removed expired premium role from ${member.user.tag});
                    await member.send({ content:💔 Your premium subscription has expired.` }).catch(() => {});
                }
            } catch (err) {
                console.error('Error removing expired subscription:', err);
            }
            users.subscriptions.splice(i, 1);
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
    }
}, 60 * 1000);

// Interaction handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, user, channel } = interaction;

    // ===== /subscribe command =====
    if (commandName === 'subscribe') {
        if (!interaction.member.roles.cache.has(config.adminRoleId)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('target');
        const durationSeconds = interaction.options.getInteger('duration') || 2592000; 
        const cooldownSeconds = interaction.options.getInteger('cooldown') || 0;

        if (!targetUser) {
            return interaction.reply({ content: 'Please provide a user to subscribe!', ephemeral: true });
        }

        const days = Math.floor(durationSeconds / 86400);
        const hours = Math.floor((durationSeconds % 86400) / 3600);
        const minutes = Math.floor((durationSeconds % 3600) / 60);
        const seconds = durationSeconds % 60;

        let durationText = '';
        if (days) durationText += ${days}d ;
        if (hours) durationText += ${hours}h ;
        if (minutes) durationText += ${minutes}m ;
        if (seconds) durationText += ${seconds}s;

        try {
            const member = await interaction.guild.members.fetch(targetUser.id);
            await member.roles.add(config.premiumRoleId);

            if (!users.subscriptions) users.subscriptions = [];
            users.subscriptions.push({
                userId: targetUser.id,
                expiresAt: Date.now() + durationSeconds * 1000,
                cooldown: cooldownSeconds
            });
            fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

            const publicEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🎉 New Premium Subscriber! 🎉')
                .setDescription(✨ <@${targetUser.id}> just got **premium**!\nSubscribed for **${durationText.trim()}** 🎊)
                .setThumbnail(LUX_LOGO)
                .setImage('https://media.giphy.com/media/3o7aD6vRNRlWlLXdJ2/giphy.gif')
                .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
                .setTimestamp();

            await interaction.reply({ embeds: [publicEmbed], ephemeral: false });
            console.log(${targetUser.tag} subscribed successfully for ${durationSeconds}s with ${cooldownSeconds}s cooldown.);
        } catch (err) {
            console.error('Subscribe command error:', err);
            if (!interaction.replied) {
                await interaction.reply({ content: '❌ Something went wrong with subscribing!', ephemeral: true });
            }
        }
    }

    // ===== /gen command =====
    if (commandName === 'gen') {
        const cooldown = cooldowns.get(user.id);
        const now = Date.now();
        if (cooldown && now - cooldown < 1000*60*1) {
            const remaining = Math.ceil((1000*60 - (now - cooldown))/1000);
            return interaction.reply({ 
                embeds: [
                    new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle('⏱ Cooldown')
                        .setDescription(You need to wait **${remaining} seconds** before generating again!)
                        .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
                ],
                ephemeral: true
            });
        }

        const hasPremium = users.subscriptions.some(sub => sub.userId === user.id && sub.expiresAt > Date.now());
        if (!hasPremium) {
            return interaction.reply({ content: '❌ You must be subscribed to generate an account!', ephemeral: true });
        }

        if (!users.stock.length) return interaction.reply({ content: 'No stock available!', ephemeral: true });

        const account = users.stock.shift();
        users.used.push(account);
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
        cooldowns.set(user.id, now);

        users.stats.userCounts[user.id] = (users.stats.userCounts[user.id] || 0) + 1;
        users.stats.logs.push({ userId: user.id, time: now });
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

        const dmEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('✨ Your Lux Account')
            .setDescription(`Here’s your account info:\n\`\`\`${account}\`\`\``)
            .setThumbnail(LUX_LOGO)
            .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
            .setTimestamp();
        try { await user.send({ embeds: [dmEmbed] }); } catch {}

        const publicEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎉 Account Generated! 🎉')
            .setDescription(<@${user.id}> just generated an account! 🤩)
            .setThumbnail(LUX_LOGO)
            .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
            .setTimestamp();
        await channel.send({ embeds: [publicEmbed] });

        await updateLeaderboard(channel);
    }

    // ===== /stock command =====
    if (commandName === 'stock') {
        if (!interaction.member.roles.cache.has(config.adminRoleId)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }

        const file = interaction.options.getAttachment('file');
        try {
            const response = await fetch(file.url);
            const text = await response.text();
            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

            users.stock = users.stock.concat(lines);
            fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🎉 Stock Added! 🎉')
                .setDescription(Stock has been added, you’re welcome! 🤩\n**${lines.length} new accounts** now available! 🎆🎊)
                .setThumbnail(LUX_LOGO)
                .setImage('https://media.giphy.com/media/3o7aD6vRNRlWlLXdJ2/giphy.gif')
                .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
                .setTimestamp();

            await channel.send({ content: '@here', embeds: [embed] });
        } catch (err) {
            console.error('Stock command error:', err);
            await interaction.reply({ content: '❌ Failed to add stock!', ephemeral: true });
        }
    }

    // ===== /removestock command =====
    if (commandName === 'removestock') {
        if (!interaction.member.roles.cache.has(config.adminRoleId)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }

        const removedAmount = users.stock.length;

        users.stock = [];
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('🗑️ Stock Cleared!')
            .setDescription(All stock has been removed!\n\n**${removedAmount} accounts deleted.**)
            .setThumbnail(LUX_LOGO)
            .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }

    // ===== /stats command =====
    if (commandName === 'stats') {
        if (!interaction.member.roles.cache.has(config.adminRoleId)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: false });

        const now = Date.now();
        const last24h = now - 24*60*60*1000;
        const logs = users.stats.logs || [];

        const lifetimeTotal = Object.values(users.stats.userCounts || {}).reduce((a,b)=>a+b,0);
        const lifetimeUnique = Object.keys(users.stats.userCounts || {}).length;
        const lifetimeHours = Math.max(1, (now - (users.stats.startTime || now))/1000/3600);
        const lifetimeAvg = (lifetimeTotal/lifetimeHours).toFixed(2);

        const counts24 = {};
        logs.filter(log => log.time >= last24h).forEach(log => {
            counts24[log.userId] = (counts24[log.userId] || 0)+1;
        });
        const total24 = Object.values(counts24).reduce((a,b)=>a+b,0);
        const unique24 = Object.keys(counts24).length;
        const avg24 = (total24/24).toFixed(2);

        const stockRemaining = users.stock.length;

        const lifetimeTop = Object.entries(users.stats.userCounts || {})
            .sort((a,b)=> b[1]-a[1])
            .slice(0,5)
            .map(([uid,count],i)=> ${i+1}. <@${uid}> (${count}))
            .join('\n') || 'N/A';
        const top24h = Object.entries(counts24)
            .sort((a,b)=> b[1]-a[1])
            .slice(0,5)
            .map(([uid,count],i)=> ${i+1}. <@${uid}> (${count}))
            .join('\n') || 'N/A';

        let mostActivePremium = 'N/A';
        if (users.subscriptions.length) {
            const premiumCounts = users.subscriptions.map(sub => ({
                userId: sub.userId,
                count: users.stats.userCounts[sub.userId] || 0
            }));
            premiumCounts.sort((a,b)=> b.count - a.count);
            const topPremium = premiumCounts[0];
            if (topPremium.count > 0) {
                mostActivePremium = <@${topPremium.userId}> (${topPremium.count} generated);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📊 Lux Bot Stats')
            .setThumbnail(LUX_LOGO)
            .addFields(
                { name: '💎 Total Generated (Lifetime)', value: ${lifetimeTotal}, inline: true },
                { name: '💎 Total Generated (24h)', value: ${total24}, inline: true },
                { name: '👤 Unique Users (Lifetime)', value: ${lifetimeUnique}, inline: true },
                { name: '👤 Unique Users (24h)', value: ${unique24}, inline: true },
                { name: '⏱ Average/hour (Lifetime)', value: ${lifetimeAvg}, inline: true },
                { name: '⏱ Average/hour (24h)', value: ${avg24}, inline: true },
                { name: '📦 Stock Remaining', value: ${stockRemaining}, inline: true },
                { name: '🏆 Top Generators (Lifetime)', value: lifetimeTop, inline: true },
                { name: '🏆 Top Generators (24h)', value: top24h, inline: true },
                { name: '💫 Most Active Premium User', value: mostActivePremium, inline: true }
            )
            .setFooter({ text: 'Lux Generator', iconURL: LUX_LOGO })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
});

// Login
client.login(process.env.TOKEN);