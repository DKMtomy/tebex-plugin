import { setInterval, clearInterval } from 'node:timers';
import type { Logger, Serenity, Player as IPlayer } from '@serenityjs/serenity';
import chalk from 'chalk';

// Creds to nobu.sh for the type, i CBA rn, its 4 am and i am bored lmfao

// Define interface for player data
interface Player {
	id: number;
	name: string;
	uuid: string;
}

// Define interface for Tebex commands
export interface TebexDueOnlineCommands<T extends CommandO = CommandO> {
	commands: T[];
}

// Define interface for Tebex command conditions
export interface CommandO {
	command: string;
	conditions: ConditionsO;
	id: number;
	package: number;
	payment: number;
}

// Define interface for command conditions
export interface ConditionsO {
	delay: number;
	slots: number;
}

// Define interface for additional metadata
interface Meta {
	execute_offline: boolean;
	more: boolean;
	next_check: number;
}

// Define Tebex API response structure
interface TebexResponse<T extends Player = Player> {
	meta: Meta;
	players: T[];
}

// Tebex class for managing Tebex commands and players
class Tebex<T extends Player = Player> {
	protected _tebexSecret: string = 'your key here'; // Tebex secret key
	protected _baseURL: string = 'https://plugin.tebex.io'; // Tebex API base URL
	protected duePlayers: Map<string, T>; // Map of players with due commands
	protected offlineCommands = false; // Flag indicating whether offline commands should be executed
	protected shouldLog = false; // Flag indicating whether to log Tebex queue activity
	protected onlinePlayers: Map<string, IPlayer>; // Map of online players
	protected logger: Logger; // Logger instance
	protected serenity: Serenity; // Serenity instance
	private intervalId: NodeJS.Timeout | null = null; // Interval ID for periodic updates

	/**
	 * Constructs a new Tebex instance.
	 *
	 * @param logger The logger instance to use for logging messages.
	 * @param serenity The Serenity instance for accessing game data.
	 * @param tebexSecret The Tebex secret key (optional).
	 */
	public constructor(logger: Logger, serenity: Serenity, tebexSecret?: string) {
		this._tebexSecret = tebexSecret ? tebexSecret : this._tebexSecret;
		this.logger = logger;
		this.serenity = serenity;
		this.duePlayers = new Map<string, T>();
		this.onlinePlayers = new Map<string, IPlayer>();
	}

	/**
	 * Starts the Tebex manager.
	 */
	public start(): void {
		this.logger.log(chalk.green('Tebex manager has started!'));
		let counter = 0;
		this.intervalId = setInterval(async () => {
			this.updateOnlinePlayers();
			counter++;
			if (counter % 5 === 0) {
				await this.checkQueue();
				await this.__sweepInterval();
			}
		}, 1_000);
	}

	/**
	 * Stops the Tebex manager.
	 */
	public stop(): void {
		this.logger.log(chalk.red('Tebex manager has stopped!'));
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/**
	 * Updates the list of online players.
	 */
	protected updateOnlinePlayers(): void {
		this.onlinePlayers.clear();
		for (const [, world] of this.serenity.worlds) {
			for (const player of world.getPlayers()) {
				this.onlinePlayers.set(player.uuid, player);
			}
		}
	}

	/**
	 * Checks the Tebex queue for pending commands.
	 */
	public async checkQueue(): Promise<void> {
		try {
			const response = await fetch(`${this._baseURL}/queue`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'X-Tebex-Secret': this._tebexSecret,
				},
			});

			if (!response.ok) {
				this.logger.error(`Failed to sweep the Tebex queue. Status: ${response.status}`);
				return;
			}

			const jsonData = (await response.json()) as TebexResponse<T>;

			this.offlineCommands = jsonData.meta.execute_offline;
			this.duePlayers = new Map(jsonData.players.map((p) => [p.uuid, p]));

			if (this.shouldLog) {
				this.logger.log(chalk.green(`GET /queue ${response.status}`));
				this.logger.log(
					chalk.grey(
						`Found ${jsonData.players.length} players awaiting rewards with${
							jsonData.meta.execute_offline ? '' : ' NO'
						} Offline Commands!`,
					),
				);
			}
		} catch (error) {
			this.logger.error(`An error occurred while sweeping the Tebex queue: ${error.message}`);
		}
	}

	/**
	 * Executes commands for due players.
	 *
	 * @private
	 */
	private async __sweepInterval(): Promise<void> {
		const duePlayers = Array.from(this.duePlayers.values());
		const onlinePlayers = Array.from(this.onlinePlayers.values());

		const completedCommands = await this.executeCommands(duePlayers, onlinePlayers);
		await this.markAsComplete(completedCommands);
	}

	/**
	 * Executes commands for the specified players.
	 *
	 * @param duePlayers The list of players with due commands.
	 * @param onlinePlayers The list of online players.
	 * @returns A list of completed commands for each player.
	 * @private
	 */
	private async executeCommands(
		duePlayers: T[],
		onlinePlayers: IPlayer[],
	): Promise<{ commandIds: number[]; player: IPlayer }[]> {
		const results: { commandIds: number[]; player: IPlayer }[] = [];

		for (const duePlayer of duePlayers) {
			const onlinePlayer = onlinePlayers.find((p) => p.uuid === duePlayer.uuid);
			if (!onlinePlayer) continue;

			const { completedCommands } = await this.executePlayerCommands(duePlayer, onlinePlayer);
			results.push({ player: onlinePlayer, commandIds: completedCommands });
		}

		return results;
	}

	/**
	 * Executes commands for the specified player.
	 *
	 * @param duePlayer The player with due commands.
	 * @param onlinePlayer The corresponding online player.
	 * @returns The completed command IDs for the player.
	 * @private
	 */
	private async executePlayerCommands(duePlayer: T, onlinePlayer: IPlayer): Promise<{ completedCommands: number[] }> {
		const { commands } = await this._getCommands<TebexDueOnlineCommands<CommandO>>(duePlayer.id);
		const completedCommands: number[] = [];

		for (const command of commands) {
			const final = command.command.replace(/{id}/gi, onlinePlayer.uuid).replace(/{username}/gi, onlinePlayer.username);
			const emptySlots = onlinePlayer.getComponent('minecraft:inventory').container.emptySlotsCount;

			if (command.conditions.slots && emptySlots < command.conditions.slots) {
				onlinePlayer.sendMessage(
					`§cCannot claim reward, inventory needs ${command.conditions.slots} empty slots! Trying again in 10 seconds...`,
				);
				continue;
			}

			// Execute the command when implementation is added

			completedCommands.push(command.id);
		}

		this.duePlayers.delete(duePlayer.uuid);
		this.logger.log(`Completed commands: ${completedCommands.join(', ')} for ${onlinePlayer.username}`);

		return { completedCommands };
	}

	/**
	 * Marks completed commands as processed.
	 *
	 * @param results The results of executed commands.
	 * @private
	 */
	private async markAsComplete(results: { commandIds: number[]; player: IPlayer }[]): Promise<void> {
		const commandIds = results.flatMap((result) => result.commandIds);

		if (commandIds.length === 0) return;

		try {
			await this._markAsComplete(commandIds);
			for (const { player } of results) {
				this.logger.log(`Completed ${player.username}'s transactions`);
			}
		} catch (error) {
			this.logger.error(`An error occurred while marking commands as complete: ${error.message}`);
		}
	}

	/**
	 * Marks specified commands as complete in the Tebex queue.
	 *
	 * @param ids The IDs of commands to mark as complete.
	 * @private
	 */
	protected async _markAsComplete(ids: number[]): Promise<void> {
		const response = await fetch(`${this._baseURL}/queue`, {
			method: 'DELETE',
			headers: {
				'Content-Type': 'application/json',
				'X-Tebex-Secret': this._tebexSecret,
			},
			body: JSON.stringify({ ids }),
		});
	}

	/**
	 * Fetches commands for the specified transaction.
	 *
	 * @param transactionId The ID of the transaction.
	 * @returns The commands associated with the transaction.
	 * @private
	 */
	protected async _getCommands<T extends TebexDueOnlineCommands>(transactionId: number): Promise<T> {
		try {
			const response = await fetch(`${this._baseURL}/queue/onlineCommands`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					'X-Tebex-Secret': this._tebexSecret,
				},
			});

			return (await response.json()) as T;
		} catch (error) {
			this.logger.error(`An error occurred while fetching commands: ${error.message}`);
		}
	}
}

export { Tebex };
