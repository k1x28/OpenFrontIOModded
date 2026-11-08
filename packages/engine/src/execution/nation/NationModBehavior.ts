import { TileRef } from "@openfront/engine-api/game/GameMap";
import { Difficulty, UnitType } from "@openfront/engine-api/game/GameTypes";
import { TANK } from "@openfront/engine-lib/game/ModRules";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { Game, Player, Unit } from "../../game/Game";
import { ConstructionExecution } from "../ConstructionExecution";
import { isDrivable } from "../ModMovement";
import { MoveWarshipExecution } from "../MoveWarshipExecution";

/** Tanks a nation fields at most, however big it is. */
const MAX_TANKS = 6;
/** One more tank per this many owned tiles. */
const TILES_PER_TANK = 200;
/** Airports a nation builds at most. */
const MAX_AIRPORTS = 3;
/** One airport per this many cities (at least one once it has a city). */
const CITIES_PER_AIRPORT = 3;
/** Fighter jets per airport. */
const JETS_PER_AIRPORT = 2;
/** Jets only chase enemy planes this close (manhattan tiles). */
const JET_CHASE_RANGE = 220;
/** Border tiles looked at when picking where to station a unit. */
const BORDER_SCAN_LIMIT = 400;
/** Percent chance per nation tick to build each unit, by difficulty. */
const BUILD_CHANCE: Record<Difficulty, number> = {
  [Difficulty.Easy]: 15,
  [Difficulty.Medium]: 25,
  [Difficulty.Hard]: 40,
  [Difficulty.Impossible]: 60,
};
/** Gold kept back, in multiples of the unit's cost, before a nation buys one. */
const RESERVE_COST_MULTIPLE = 2;

/**
 * How nations use the modded units, the way NationWarshipBehavior does for
 * ships: build an airport for the income, field tanks and fighter jets, and
 * keep them stationed where the nation is under pressure.
 *
 * Holds no state of its own, so it needs no snapshot: everything it reads is
 * in the game, and the nation creates it on first use.
 */
export class NationModBehavior {
  constructor(
    private random: PseudoRandom,
    private game: Game,
    private player: Player,
  ) {}

  /** One nation tick of decisions. */
  handle(): void {
    this.maybeBuildAirport();
    this.maybeSpawnTank();
    this.maybeSpawnJet();
    this.commandTanks();
    this.commandJets();
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private canAfford(type: UnitType): boolean {
    const cost = this.game.unitInfo(type).cost(this.game, this.player);
    // Free (infinite gold lobbies) or comfortably affordable.
    return (
      cost === 0n || this.player.gold() > cost * BigInt(RESERVE_COST_MULTIPLE)
    );
  }

  private buildChance(): number {
    return BUILD_CHANCE[this.game.config().gameConfig().difficulty];
  }

  /** Airports pay like ports do, so nations want a few next to their cities. */
  maybeBuildAirport(): boolean {
    if (this.game.config().isUnitDisabled(UnitType.Airport)) return false;
    if (
      !this.random.chance(Math.max(1, Math.floor(100 / this.buildChance())))
    ) {
      return false;
    }
    const cities = this.player.unitCount(UnitType.City);
    const airports = this.player.unitCount(UnitType.Airport);
    const wanted = Math.min(
      MAX_AIRPORTS,
      Math.max(1, Math.floor(cities / CITIES_PER_AIRPORT)),
    );
    if (cities === 0 || airports >= wanted) return false;
    if (!this.canAfford(UnitType.Airport)) return false;

    const anchors = this.player.units(UnitType.City);
    const anchor = this.random.randElement(anchors);
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = this.game.x(anchor.tile()) + this.random.nextInt(-12, 13);
      const y = this.game.y(anchor.tile()) + this.random.nextInt(-12, 13);
      if (!this.game.isValidCoord(x, y)) continue;
      const tile = this.game.ref(x, y);
      if (this.game.owner(tile) !== this.player) continue;
      const spot = this.player.canBuild(UnitType.Airport, tile);
      if (spot === false) continue;
      this.game.addExecution(
        new ConstructionExecution(this.player, UnitType.Airport, spot),
      );
      return true;
    }
    return false;
  }

  /** A tank rolls out of a factory and parks at the front. */
  maybeSpawnTank(): boolean {
    if (this.game.config().isUnitDisabled(UnitType.Tank)) return false;
    if (
      !this.random.chance(Math.max(1, Math.floor(100 / this.buildChance())))
    ) {
      return false;
    }
    const factories = this.player
      .units(UnitType.Factory)
      .filter((f) => !f.isUnderConstruction());
    if (factories.length === 0) return false;
    const wanted = Math.min(
      MAX_TANKS,
      1 + Math.floor(this.player.numTilesOwned() / TILES_PER_TANK),
    );
    if (this.player.unitCount(UnitType.Tank) >= wanted) return false;
    if (!this.canAfford(UnitType.Tank)) return false;

    const tile = this.frontTile(this.hostileTarget()) ?? null;
    if (tile === null || !isDrivable(this.game, tile)) return false;
    if (this.player.canBuild(UnitType.Tank, tile) === false) return false;
    this.game.addExecution(
      new ConstructionExecution(this.player, UnitType.Tank, tile),
    );
    return true;
  }

  /** A jet takes off from an airport and patrols the front. */
  maybeSpawnJet(): boolean {
    if (this.game.config().isUnitDisabled(UnitType.FighterJet)) return false;
    if (
      !this.random.chance(Math.max(1, Math.floor(100 / this.buildChance())))
    ) {
      return false;
    }
    const airports = this.player
      .units(UnitType.Airport)
      .filter((a) => !a.isUnderConstruction());
    if (airports.length === 0) return false;
    if (
      this.player.unitCount(UnitType.FighterJet) >=
      airports.length * JETS_PER_AIRPORT
    ) {
      return false;
    }
    if (!this.canAfford(UnitType.FighterJet)) return false;

    const tile =
      this.frontTile(this.hostileTarget()) ??
      this.random.randElement(airports).tile();
    if (this.player.canBuild(UnitType.FighterJet, tile) === false) return false;
    this.game.addExecution(
      new ConstructionExecution(this.player, UnitType.FighterJet, tile),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Commanding
  // -------------------------------------------------------------------------

  /** Whoever is attacking us, else a random hostile neighbour. */
  private hostileTarget(): Player | null {
    for (const attack of this.player.incomingAttacks()) {
      const attacker = attack.attacker();
      if (attack.retreating() || attacker === this.player) continue;
      if (!this.player.isFriendly(attacker)) return attacker;
    }
    const hostile: Player[] = [];
    for (const n of this.player.nearby()) {
      if (n.isPlayer() && !this.player.isFriendly(n)) hostile.push(n);
    }
    return hostile.length > 0 ? this.random.randElement(hostile) : null;
  }

  /** One of our border tiles that touches `enemy`'s land. */
  private frontTile(enemy: Player | null): TileRef | undefined {
    if (enemy === null) return undefined;
    const found: TileRef[] = [];
    let scanned = 0;
    for (const border of this.player.borderTiles()) {
      if (++scanned > BORDER_SCAN_LIMIT) break;
      for (const n of this.game.neighbors(border)) {
        if (this.game.owner(n) === enemy) {
          found.push(border);
          break;
        }
      }
    }
    return found.length > 0 ? this.random.randElement(found) : undefined;
  }

  private idle(unit: Unit): boolean {
    return unit.isActive() && unit.warshipState().isInCombat !== true;
  }

  /** Tanks that are not fighting go to where the pressure is. */
  commandTanks(): void {
    if (!this.random.chance(3)) return;
    for (const tank of this.player.units(UnitType.Tank)) {
      if (!this.idle(tank)) continue;
      const tile = this.frontTile(this.hostileTarget());
      if (tile === undefined || !isDrivable(this.game, tile)) continue;
      const patrol = tank.warshipState().patrolTile ?? tank.tile();
      // Already stationed there.
      if (this.game.manhattanDist(patrol, tile) <= TANK.holdRadius * 2)
        continue;
      this.game.addExecution(
        new MoveWarshipExecution(this.player, [tank.id()], tile),
      );
    }
  }

  /** Jets chase the nearest enemy plane, else cover the front. */
  commandJets(): void {
    if (!this.random.chance(3)) return;
    const enemyPlanes = [
      ...this.game.units(UnitType.CargoPlane),
      ...this.game.units(UnitType.FighterJet),
    ].filter((u) => {
      const owner = u.owner();
      return (
        u.isActive() && owner !== this.player && !this.player.isFriendly(owner)
      );
    });
    for (const jet of this.player.units(UnitType.FighterJet)) {
      if (!this.idle(jet)) continue;
      let best: Unit | undefined;
      let bestDist = JET_CHASE_RANGE;
      for (const plane of enemyPlanes) {
        const d = this.game.manhattanDist(jet.tile(), plane.tile());
        if (d < bestDist) {
          best = plane;
          bestDist = d;
        }
      }
      const tile = best?.tile() ?? this.frontTile(this.hostileTarget());
      if (tile === undefined) continue;
      this.game.addExecution(
        new MoveWarshipExecution(this.player, [jet.id()], tile),
      );
    }
  }
}
