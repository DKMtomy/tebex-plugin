import { setTimeout } from 'node:timers';
import type { Logger, PlayerSpawned, Serenity } from '@serenityjs/serenity';
import { BasePlugin } from '@serenityjs/serenity';
import { Tebex } from './tebex.js';

export default class SamplePlugin extends BasePlugin {
	private readonly tebexManager: Tebex;

	public constructor(serenity: Serenity, logger: Logger) {
		super(serenity, logger);

		// Create a new Tebex manager.
		this.tebexManager = new Tebex(logger, serenity);
	}

	public async startup(): Promise<void> {
		this.logger.info('TebexIntegration plugin has started!');

		// Wait until the Tebex manager is defined.
		while (!this.tebexManager) {
			await new Promise((resolve) => {
				setTimeout(resolve, 1_000);
			});
		}

		// Start the Tebex manager.
		this.tebexManager.start();
	}

	public shutdown(): void {
		this.logger.info('TebexIntegration plugin has stopped!');

		// Stop the Tebex manager.
		this.tebexManager.stop();
	}
}
