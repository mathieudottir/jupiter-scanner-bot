// discord_notifications.js - Module Discord et notifications

const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');


class DiscordNotifications {
    constructor(discordToken, channelId) {
        this.discordToken = discordToken;
        this.channelId = channelId;
        this.client = new Client({ 
            intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] 
        });
        this.isConnected = false;
    }

    // INITIALISATION DISCORD
    async initialize() {
    try {
        console.log('🤖 Connexion à Discord...');
            console.log(`🔍 Discord API status check...`); // ✅ AJOUTEZ ÇA
    
    // Test rapide de l'API Discord
    try {
        const testResponse = await fetch('https://discord.com/api/v10/gateway');
        console.log(`📡 Discord API: ${testResponse.status}`);
    } catch (e) {
        console.log(`📡 Discord API error: ${e.message}`);
    }
    
    await this.client.login(this.discordToken);
        await this.client.login(this.discordToken);
        
        this.client.once('ready', () => {
            console.log(`✅ Bot connecté: ${this.client.user.tag}`);
            this.isConnected = true;
        });

        // ✅ NOUVEAU: Écouter les interactions de boutons
        this.client.on('interactionCreate', async (interaction) => {
            if (!interaction.isButton()) return;
            
            // Vérifier que c'est notre bouton "vendre tout"
            if (interaction.customId === 'sell_all_positions') {
                await this.handleSellAllButton(interaction);
            }
        });
        
        return true;
    } catch (error) {
        console.error('❌ Erreur connexion Discord:', error.message);
        this.isConnected = false;
        return false;
    }
}
        async handleSellAllButton(interaction) {
    try {
        // Déférer la réponse (on a 3 secondes pour répondre)
        await interaction.deferReply({ ephemeral: true });
        
        console.log(`🔴 BOUTON VENDRE TOUT pressé par ${interaction.user.username}`);
        
        // Récupérer les positions du trader (il faut passer la référence)
        if (!this.trader || !this.trader.positions || this.trader.positions.size === 0) {
            await interaction.editReply({
                content: '❌ Aucune position active à vendre'
            });
            return;
        }
        
        const positionsCount = this.trader.positions.size;
        
        // Confirmer l'action
        await interaction.editReply({
            content: `🔴 **VENTE D'URGENCE DÉCLENCHÉE**\n\n` +
                    `📊 ${positionsCount} position(s) en cours de vente...\n` +
                    `⏱️ Cela peut prendre quelques minutes`
        });
        
        // Déclencher la vente de toutes les positions
        let soldCount = 0;
        const positions = Array.from(this.trader.positions.entries());
        
        for (const [tokenAddress, position] of positions) {
            try {
                console.log(`🔴 Vente forcée: ${position.symbol}`);
                
                // Obtenir le prix actuel
                const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
                let currentPrice = position.buyPrice; // Fallback
                
                if (response.ok) {
                    const data = await response.json();
                    const pair = data.pairs?.find(p => p.chainId === 'solana');
                    if (pair) {
                        currentPrice = parseFloat(pair.priceUsd || position.buyPrice);
                    }
                }
                
                // Vendre la position entière
                const success = await this.trader.sellEntirePosition(
                    position, 
                    currentPrice, 
                    "VENTE MANUELLE DISCORD"
                );
                
                if (success) {
                    soldCount++;
                }
                
                // Attendre entre les ventes
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.error(`❌ Erreur vente ${position.symbol}:`, error.message);
            }
        }
        
        // Rapport final
        const embed = new EmbedBuilder()
            .setColor(soldCount === positionsCount ? 0x00ff00 : 0xff9900)
            .setTitle('🔴 RAPPORT VENTE D\'URGENCE')
            .addFields(
                {
                    name: '📊 Résultats',
                    value: `Positions vendues: ${soldCount}/${positionsCount}\n` +
                           `Positions restantes: ${this.trader.positions.size}`,
                    inline: false
                }
            )
            .setTimestamp();
            
        await interaction.followUp({
            embeds: [embed]
        });
        
    } catch (error) {
        console.error('❌ Erreur bouton vendre tout:', error.message);
        await interaction.editReply({
            content: '❌ Erreur lors de la vente des positions'
        }).catch(() => {});
    }
}
    // RÉCAP PERFORMANCE DISCORD
    async sendPerformanceRecap(stats, positions) {
    if (!this.isConnected) {
        console.log('📊 Discord non connecté - récap en console');
        this.showPerformanceRecapConsole(stats, positions);
        return;
    }

    try {
        const channel = await this.client.channels.fetch(this.channelId);
        if (!channel) return;

        const now = new Date();
        const sessionHours = ((Date.now() - stats.session.startTime) / (1000 * 60 * 60)).toFixed(1);
        
        // ✅ FIX: Win Rate sur trades FERMÉS uniquement
        const sessionClosedTrades = stats.session.wins + stats.session.losses;
        const sessionWinRate = sessionClosedTrades > 0 ? 
            ((stats.session.wins / sessionClosedTrades) * 100).toFixed(1) : '0';
        const sessionROI = stats.session.investedSOL > 0 ? 
            ((stats.session.profitSOL / stats.session.investedSOL) * 100).toFixed(1) : '0';
            
        const dailyClosedTrades = stats.daily.wins + stats.daily.losses;
        const dailyWinRate = dailyClosedTrades > 0 ? 
            ((stats.daily.wins / dailyClosedTrades) * 100).toFixed(1) : '0';
        const dailyROI = stats.daily.investedSOL > 0 ? 
            ((stats.daily.profitSOL / stats.daily.investedSOL) * 100).toFixed(1) : '0';
            
        const allTimeClosedTrades = stats.allTime.wins + stats.allTime.losses;
        const allTimeWinRate = allTimeClosedTrades > 0 ? 
            ((stats.allTime.wins / allTimeClosedTrades) * 100).toFixed(1) : '0';
        const allTimeROI = stats.allTime.totalInvestedSOL > 0 ? 
            ((stats.allTime.totalProfitSOL / stats.allTime.totalInvestedSOL) * 100).toFixed(1) : '0';

        // Embed principal
        const embed = new EmbedBuilder()
            .setColor(stats.session.profitSOL >= 0 ? 0x00ff00 : 0xff9900)
            .setTitle('📊 RÉCAP PERFORMANCE AUTO-TRADER')
            .setDescription(`**Rapport automatique toutes les 10 minutes**`)
            .addFields(
                {
                    name: `🕐 SESSION (${sessionHours}h)`,
                    // ✅ FIX: Distinguer positions vs trades fermés
                    value: `Positions total: ${stats.session.trades} | Fermés: ${sessionClosedTrades} (W:${stats.session.wins} L:${stats.session.losses})\n` +
                           `Win Rate: ${sessionWinRate}% | ROI: ${sessionROI}%\n` +
                           `Investi: ${stats.session.investedSOL.toFixed(3)} SOL\n` +
                           `Profit: ${stats.session.profitSOL > 0 ? '+' : ''}${stats.session.profitSOL.toFixed(4)} SOL\n` +
                           `🔄 Ouvertes: ${positions.size}`,
                    inline: false
                },
                {
                    name: `📅 AUJOURD'HUI`,
                    value: `Positions total: ${stats.daily.trades} | Fermés: ${dailyClosedTrades} (W:${stats.daily.wins} L:${stats.daily.losses})\n` +
                           `Win Rate: ${dailyWinRate}% | ROI: ${dailyROI}%\n` +
                           `Investi: ${stats.daily.investedSOL.toFixed(3)} SOL\n` +
                           `Profit: ${stats.daily.profitSOL > 0 ? '+' : ''}${stats.daily.profitSOL.toFixed(4)} SOL`,
                    inline: false
                },
                {
                    name: `🏆 ALL TIME`,
                    value: `Positions total: ${stats.allTime.totalTrades} | Fermés: ${allTimeClosedTrades} (W:${stats.allTime.wins} L:${stats.allTime.losses})\n` +
                           `Win Rate: ${allTimeWinRate}% | ROI: ${allTimeROI}%\n` +
                           `Investi: ${stats.allTime.totalInvestedSOL.toFixed(3)} SOL\n` +
                           `Profit Total: ${stats.allTime.totalProfitSOL > 0 ? '+' : ''}${stats.allTime.totalProfitSOL.toFixed(4)} SOL`,
                    inline: false
                }
            )
            .setTimestamp();

        // Ajouter positions actuelles si il y en a
        if (positions.size > 0) {
            let positionsText = '';
            for (const [, position] of positions.entries()) {
                const currentPrice = position.lastKnownPrice || position.buyPrice;
                const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
                const holdTimeMin = ((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0);
                
                const emoji = changePercent > 10 ? '🚀' : changePercent > 0 ? '📈' : changePercent > -10 ? '⚠️' : '🔴';
                positionsText += `${emoji} ${position.symbol}: ${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}% (${holdTimeMin}min)\n`;
            }
            
            embed.addFields({
                name: `💼 POSITIONS ACTUELLES (${positions.size})`,
                value: positionsText || 'Aucune position ouverte',
                inline: false
            });
        }
            const sellAllButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('sell_all_positions')
                .setLabel('🔴 VENDRE TOUT')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(positions.size === 0) // Désactivé si pas de positions
        );

    await channel.send({
        embeds: [embed],
        components: positions.size > 0 ? [sellAllButton] : [] // Ajouter bouton si positions actives
    });
        
        
        console.log('📊 Récap performance envoyé sur Discord');
        
    } catch (error) {
        console.error('❌ Erreur envoi récap Discord:', error.message);
        // Fallback console si Discord fail
        console.log('📊 Fallback: Récap en console');
        this.showPerformanceRecapConsole(stats, positions);
    }
}

    // Version console en backup
  showPerformanceRecapConsole(stats, positions) {
    const now = new Date();
    const sessionHours = ((Date.now() - stats.session.startTime) / (1000 * 60 * 60)).toFixed(1);
    
    console.log('\n' + '═'.repeat(80));
    console.log(`📊 RÉCAP PERFORMANCE - ${now.toLocaleString()}`);
    console.log('═'.repeat(80));
    
    // ✅ FIX: Win Rate correct
    const sessionClosedTrades = stats.session.wins + stats.session.losses;
    const sessionWinRate = sessionClosedTrades > 0 ? 
        ((stats.session.wins / sessionClosedTrades) * 100).toFixed(1) : '0';
    const sessionROI = stats.session.investedSOL > 0 ? 
        ((stats.session.profitSOL / stats.session.investedSOL) * 100).toFixed(1) : '0';
        
    console.log(`🕐 SESSION (${sessionHours}h):`);
    console.log(`   Positions total: ${stats.session.trades} | Fermés: ${sessionClosedTrades} | Wins: ${stats.session.wins} | Losses: ${stats.session.losses} | WR: ${sessionWinRate}%`);
    console.log(`   Positions ouvertes: ${positions.size}`);
    console.log(`   Investi: ${stats.session.investedSOL.toFixed(3)} SOL | Profit: ${stats.session.profitSOL > 0 ? '+' : ''}${stats.session.profitSOL.toFixed(4)} SOL | ROI: ${sessionROI}%`);
    console.log('═'.repeat(80));
}

    // NOTIFICATION ACHAT
// NOTIFICATION ACHAT - VERSION DEBUG
    async notifyBuy(position, tokenData, sellLevels, stopLossPercent) {
        console.log(`🔔 notifyBuy appelé pour ${position.symbol}`);
        console.log(`🤖 Discord connecté: ${this.isConnected}`);
        
        if (!this.isConnected) {
            console.log(`❌ Discord non connecté - notification ignorée`);
            return;
        }

        try {
            console.log(`📡 Tentative récupération channel: ${this.channelId}`);
            const channel = await this.client.channels.fetch(this.channelId);
            
            if (!channel) {
                console.log(`❌ Channel introuvable: ${this.channelId}`);
                return;
            }
            
            console.log(`✅ Channel trouvé: ${channel.name}`);
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`🛡️ ACHAT SÉCURISÉ - ${position.symbol}`)
                .setDescription(`**Token whitelist vérifié acheté**`)
                .addFields(
                    {
                        name: '💰 Détails achat',
                        value: `Prix: ${position.buyPrice.toFixed(6)}\nQuantité: ${position.buyAmount.toLocaleString()}\nInvesti: ${position.solSpent} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance',
                        value: `1h: +${tokenData.priceChange?.h1?.toFixed(1) || 'N/A'}%\n24h: +${tokenData.priceChange?.h24?.toFixed(1) || 'N/A'}%`,
                        inline: true
                    },
                    {
                        name: '🎯 Stratégie',
                        value: `Ventes: +${sellLevels[0].profit}% (${sellLevels[0].percentage}%), +${sellLevels[1].profit}% (${sellLevels[1].percentage}%), +${sellLevels[2].profit}% (${sellLevels[2].percentage}%), +${sellLevels[3].profit}% (${sellLevels[3].percentage}%)\nStop-Loss: -${stopLossPercent}%`,
                        inline: false
                    },
                    {
                        name: '🔗 Liens',
                        value: `[📊 DexScreener](https://dexscreener.com/solana/${position.tokenAddress}) | [🔍 TX Achat](https://solscan.io/tx/${position.buyTxid})`,
                        inline: false
                    }
                )
                .setTimestamp();
            
            console.log(`📤 Envoi message Discord...`);
            
            const sentMessage = await channel.send({
                content: `🛡️ **ACHAT SÉCURISÉ** 🛡️\n${position.symbol} - Token whitelist vérifié !`,
                embeds: [embed]
            });
            
            console.log(`✅ Message Discord envoyé: ${sentMessage.id}`);
            
        } catch (error) {
            console.error('❌ Erreur notification achat:', error.message);
            console.error('🔍 Stack trace:', error.stack);
        }
    }
    // NOTIFICATION VENTE PARTIELLE
    async notifyPartialSell(position, solReceived, profit, profitPercent, level, txid) {
        if (!this.isConnected) return;

        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle(`💰 VENTE PARTIELLE - ${position.symbol}`)
                .setDescription(`**${level.reason}** - ${level.percentage}% vendu`)
                .addFields(
                    {
                        name: '💰 SOL reçu',
                        value: `${solReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📈 Performance',
                        value: `+${profitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} min`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `💰 **VENTE PARTIELLE** 💰\n${position.symbol}: ${level.percentage}% vendu à +${profitPercent.toFixed(1)}%`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente partielle:', error.message);
        }
    }

    // NOTIFICATION VENTE FINALE
    async notifyFinalSell(position, totalSolReceived, totalProfit, totalProfitPercent, reason, txid) {
        if (!this.isConnected) return;

        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const isProfit = totalProfit > 0;
            const color = isProfit ? 0x00ff00 : 0xff0000;
            const emoji = isProfit ? '🎉' : '😢';
            
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`🏁 POSITION FERMÉE - ${position.symbol}`)
                .setDescription(`**${reason}**`)
                .addFields(
                    {
                        name: '💰 SOL total reçu',
                        value: `${totalSolReceived.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: `${emoji} Profit/Perte`,
                        value: `${totalProfit > 0 ? '+' : ''}${totalProfit.toFixed(4)} SOL`,
                        inline: true
                    },
                    {
                        name: '📊 Performance',
                        value: `${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}%`,
                        inline: true
                    },
                    {
                        name: '⏱️ Durée totale',
                        value: `${((Date.now() - position.buyTime) / (1000 * 60)).toFixed(0)} minutes`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `${isProfit ? '🎉' : '😢'} **POSITION FERMÉE** ${isProfit ? '🎉' : '😢'}\n${position.symbol}: ${totalProfitPercent > 0 ? '+' : ''}${totalProfitPercent.toFixed(1)}% total`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification vente finale:', error.message);
        }
    }

    // NOTIFICATION MOONSHOT CHUNKS
    async notifyMoonshotChunkSell(position, soldChunks, totalSolReceived, currentPrice) {
        if (!this.isConnected) return;

        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if (!channel) return;
            
            const changePercent = ((currentPrice / position.buyPrice) - 1) * 100;
            
            const embed = new EmbedBuilder()
                .setColor(0xffd700)
                .setTitle(`🌙 MOONSHOT PARTIEL - ${position.symbol}`)
                .setDescription(`**Vente par chunks réussie !**`)
                .addFields(
                    {
                        name: '🚀 Performance',
                        value: `+${changePercent.toFixed(0)}%`,
                        inline: true
                    },
                    {
                        name: '🧩 Chunks vendus',
                        value: `${soldChunks}/5 chunks`,
                        inline: true
                    },
                    {
                        name: '💰 SOL reçu',
                        value: `${totalSolReceived.toFixed(4)} SOL`,
                        inline: true
                    }
                )
                .setTimestamp();
            
            await channel.send({
                content: `🌙 **MOONSHOT ALERT** 🌙\n${position.symbol}: +${changePercent.toFixed(0)}% - Vente partielle réussie !`,
                embeds: [embed]
            });
            
        } catch (error) {
            console.error('❌ Erreur notification moonshot:', error.message);
        }
    }
}

module.exports = DiscordNotifications;