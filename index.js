const SettingProvider = require('discord.js-commando').SettingProvider;
const { Guild, GuildMember, User } = require('discord.js');
/**
 * Uses knex to store settings with guilds
 * @extends {SettingProvider}
 */
class FirebaseProvider extends SettingProvider {
    /**
     * @param {db} fire - Database Connection for the provider
     */
    constructor(db) {
        super();

        /**
         * Database that will be used for storing/retrieving settings
         * @type {db}
         */
        this.db = db;

        /**
         * Client that the provider is for (set once the client is ready, after using {@link CommandoClient#setProvider})
         * @name FirebaseProvider#client
         * @type {CommandoClient}
         * @readonly
         */
        Object.defineProperty(this, 'client', {
            value: null,
            writable: true
        });

        /**
         * Settings cached in memory, mapped by guild ID (or 'global')
         * @type {Map}
         * @private
         */
        this.settings = new Map();

        /**
         * Listeners on the Client, mapped by the event name
         * @type {Map}
         * @private
         */
        this.listeners = new Map();

        /**
         * Prepared statement to insert or replace a settings row
         * @type {SyncSQLiteStatement}
         * @private
         */
        this.insertOrReplaceStmt = null;

        /**
         * Prepared statement to delete an entire settings row
         * @type {SyncSQLiteStatement}
         * @private
         */
        this.deleteStmt = null;

        this.options = {
            tableName: "settings"
        };

        this.columns = [];
    }

    async init(client) {
        this.client = client;
        let collection = {};
        if(collection != null) {
            const snap = await this.db.ref('settings').once('value');
            collection = snap.val();
        }
        console.log(collection);

        for(let guild in collection) {
            const g = guild !== '0' ? guild : 'global';
            console.log(g);
            this.settings.set(g, collection[guild]);
            this.setupGuild(g, collection[guild]);
        }

        

       
        this.listeners
            .set('commandPrefixChange', (guild, prefix) => this.set(guild, 'prefix', prefix))
            .set('commandStatusChange', (guild, command, enabled) => this.set(guild, `cmd-${command.name}`, enabled))
            .set('groupStatusChange', (guild, group, enabled) => this.set(guild, `grp-${group.id}`, enabled))
            .set('guildCreate', guild => {
                const settings = this.settings.get(guild);
                if (!settings) return;
                this.setupGuild(guild.id, settings);
            })
            .set('commandRegister', async command => {
                
                for (const [guild, settings] of this.settings) {
                    if (guild !== 'global' && !client.guilds.cache.has(guild)) continue;
                    this.setupGuildCommand(client.guilds.cache.get(guild), command, settings);
                }
            })
            .set('groupRegister', async group => {
                
                for (const [guild, settings] of this.settings) {
                    if (guild !== 'global' && !client.guilds.cache.has(guild)) continue;
                    this.setupGuildGroup(client.guilds.cache.get(guild), group, settings);
                }
            });
        for (const [event, listener] of this.listeners) client.on(event, listener);
        
    }

    destroy() {
        // Remove all listeners from the client
        for (const [event, listener] of this.listeners) this.client.removeListener(event, listener);
        this.listeners.clear();
    }



    get(guild, key, defVal) {
		const settings = this.settings.get(SettingProvider.getGuildID(guild));
		return settings ? typeof settings[key] !== 'undefined' ? settings[key] : defVal : defVal;
	}

    async set(guild, key, val) {
		const guildId = SettingProvider.getGuildID(guild);
		let settings = this.settings.get(guildId);
		if(!settings) {
			settings = {};
			this.settings.set(guildId, settings);
		}

        settings[key] = val;
        
        await this.updateGuild(guildId, settings);

		if(guildId === 'global') this.updateOtherShards(key, val);
		return val;
	}

    async remove(guild, key) {
		const guildId = SettingProvider.getGuildID(guild);
		const settings = this.settings.get(guildId);
		if(!settings || typeof settings[key] === 'undefined') return;

		const val = settings[key];
        delete settings[key]; // NOTE: I know this isn't efficient, but it does the job.

        await this.updateGuild(guildId, settings);

		if(guildId === 'global') this.updateOtherShards(key, undefined);
		return val;
	}

    async clear(guild) {
		const guildId = SettingProvider.getGuildID(guild);
		if(!this.settings.has(guildId)) return;
        this.settings.delete(guildId);
        await this.db.ref('settings/' + guildId).remove();
    }

    async updateGuild(guild, settings) {
        guild = guild !== 'global' ? guild : 0;

        await this.db.ref('settings/'+guild).update(settings);
        
    }
    /**
	 * Loads all settings for a guild
	 * @param guild - Guild ID to load the settings of (or 'global')
	 * @param settings - Settings to load
	 */
	 setupGuild(guildId, settings) {
		if(typeof guildId !== 'string') throw new TypeError('The guild must be a guild ID or "global".');
		const guild = this.client.guilds.cache.get(guildId) || null;
        console.log(settings.prefix);

		// Load the command prefix
		if(typeof settings.prefix !== 'undefined') {
			if(guild) {
                guild.commandPrefix = settings.prefix;
            }
			else {
                if(guildId == 'global'){
                this.client.commandPrefix = settings.prefix;
                }
            }
		}

		// Load all command/group statuses
        if(guild || guildId == 'global'){
		for(const command of this.client.registry.commands.values()) this.setupGuildCommand(guild, command, settings);
		for(const group of this.client.registry.groups.values()) this.setupGuildGroup(guild, group, settings);
        }
	}

    /**
     * Sets up a command's status in a guild from the guild's settings
     * @param {?CommandoGuild} guild - Guild to set the status in
     * @param {Command} command - Command to set the status of
     * @param {Object} settings - Settings of the guild
     * @private
     */
    setupGuildCommand(guild, command, settings) {
        if (typeof settings[`cmd-${command.name}`] === 'undefined') return;
        command.setEnabledIn(guild, settings[`cmd-${command.name}`]);

    }

    /**
     * Sets up a command group's status in a guild from the guild's settings
     * @param {?CommandoGuild} guild - Guild to set the status in
     * @param {CommandGroup} group - Group to set the status of
     * @param {Object} settings - Settings of the guild
     * @private
     */
    setupGuildGroup(guild, group, settings) {
        if (typeof settings[`grp-${group.id}`] === 'undefined') return;
        group.setEnabledIn(guild, settings[`grp-${group.id}`]);

    }

    /**
     * Updates a global setting on all other shards if using the {@link ShardingManager}.
     * @param {string} key - Key of the setting to update
     * @param {*} val - Value of the setting
     * @private
     */
    updateOtherShards(key, val) {
        if (!this.client.shard) return;
        key = JSON.stringify(key);
        val = typeof val !== 'undefined' ? JSON.stringify(val) : 'undefined';
        this.client.shard.broadcastEval(`
			const ids = [${this.client.shard.ids.join(',')}];
			if(!this.shard.ids.some(id => ids.includes(id)) && this.provider && this.provider.settings) {
				let global = this.provider.settings.get('global');
				if(!global) {
					global = {};
					this.provider.settings.set('global', global);
				}
				global[${key}] = ${val};
			}
		`);
    }

    

   

}

module.exports = FirebaseProvider;