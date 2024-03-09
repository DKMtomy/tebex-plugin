import { setInterval, clearInterval } from 'node:timers';
import type { Logger, Serenity, Player as IPlayer } from '@serenityjs/serenity';
import chalk from 'chalk';

interface Player {
	id: number;
	name: string;
	uuid: string;
}

export interface TebexDueOnlineCommands<T extends CommandO = CommandO> {
	commands: T[];
}

export interface CommandO {
	command: string;
	conditions: ConditionsO;
	id: number;
	package: number;
	payment: number;
}

export interface ConditionsO {
	delay: number;
	slots: number;
}

interface Meta {
	execute_offline: boolean;
	more: boolean;
	next_check: number;
}

interface TebexResponse<T extends Player = Player> {
	meta: Meta;
	players: T[];
}

class Tebex<T extends Player = Player> {
	protected _tebexSecret: string = '2ee32bb1d3d0afe5a6e5299a7a0f4458e4f949fe';
	protected _baseURL: string = 'https://plugin.tebex.io';
	protected duePlayers: Map<string, T>;
	protected offlineCommands = false;
	// set this to true to log the Tebex queue
	protected shouldLog = false;
	protected onlinePlayers: Map<string, IPlayer>;
	protected logger: Logger;
	protected serenity: Serenity;
	private intervalId: NodeJS.Timeout | null = null;

	public constructor(logger: Logger, serenity: Serenity, tebexSecret?: string) {
		this._tebexSecret = tebexSecret ? tebexSecret : this._tebexSecret;
		this.logger = logger;
		this.serenity = serenity;
		this.duePlayers = new Map<string, T>();
		this.onlinePlayers = new Map<string, IPlayer>();
	}

	public start(): void {
		// add a logger message to indicate that the Tebex manager has started with green color
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

	public stop(): void {
		// add a logger message to indicate that the Tebex manager has stopped with red color
		this.logger.log(chalk.red('Tebex manager has stopped!'));
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	protected updateOnlinePlayers(): void {
		this.onlinePlayers.clear();
		for (const [, world] of this.serenity.worlds) {
			for (const player of world.getPlayers()) {
				this.onlinePlayers.set(player.uuid, player);
			}
		}
	}

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

	private async __sweepInterval(): Promise<void> {
		const duePlayers = Array.from(this.duePlayers.values());
		const onlinePlayers = Array.from(this.onlinePlayers.values());

		const completedCommands = await this.executeCommands(duePlayers, onlinePlayers);
		await this.markAsComplete(completedCommands);
	}

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

			// execute the command when we implement the command execution

			completedCommands.push(command.id);
		}

		this.duePlayers.delete(duePlayer.uuid);
		this.logger.log(`Completed commands: ${completedCommands.join(', ')} for ${onlinePlayer.username}`);

		return { completedCommands };
	}

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
