import {
  Cell,
  Difficulty,
  Nation,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { PseudoRandom } from "@openfront/engine-lib/PseudoRandom";
import { EngineConfig } from "@openfront/engine/configuration/EngineConfig";
import { NationModBehavior } from "@openfront/engine/execution/nation/NationModBehavior";
import { NationExecution } from "@openfront/engine/execution/NationExecution";
import { Game, Player } from "@openfront/engine/game/Game";
import { setup } from "./util/Setup";
import { executeTicks } from "./util/utils";

let game: Game;
let nation: Player;
let enemy: Player;
let ai: NationModBehavior;

function claim(player: Player, x0: number, y0: number, w: number, h: number) {
  for (let x = x0; x < x0 + w; x++) {
    for (let y = y0; y < y0 + h; y++) player.conquer(game.ref(x, y));
  }
}

/** Calls the behaviour's decisions until `done` holds, running the game between. */
function drive(step: () => void, done: () => boolean, rounds = 400): boolean {
  for (let i = 0; i < rounds; i++) {
    step();
    executeTicks(game, 3);
    if (done()) return true;
  }
  return false;
}

describe("Nations use tanks, airports and fighter jets", () => {
  beforeEach(async () => {
    game = await setup(
      "plains",
      { infiniteGold: true, instantBuild: true, difficulty: Difficulty.Hard },
      [
        new PlayerInfo("nation", PlayerType.Nation, null, "n1"),
        new PlayerInfo("enemy", PlayerType.Human, null, "e1"),
      ],
    );
    nation = game.player("n1");
    enemy = game.player("e1");
    // Side by side: the nation on the left, the enemy on the right.
    claim(nation, 10, 10, 30, 30);
    claim(enemy, 40, 10, 30, 30);
    nation.addGold(10_000_000_000n);
    nation.setSpawnTile(game.ref(20, 20));
    enemy.setSpawnTile(game.ref(60, 20));
    ai = new NationModBehavior(new PseudoRandom(7), game, nation);
  });

  test("builds an airport once it has a city", () => {
    expect(
      drive(
        () => ai.maybeBuildAirport(),
        () => nation.unitCount(UnitType.Airport) > 0,
        50,
      ),
    ).toBe(false);
    nation.buildUnit(UnitType.City, game.ref(15, 15), {});
    expect(
      drive(
        () => ai.maybeBuildAirport(),
        () => nation.unitCount(UnitType.Airport) > 0,
      ),
    ).toBe(true);
    const airport = nation.units(UnitType.Airport)[0];
    expect(game.owner(airport.tile())).toBe(nation);
  });

  test("fields a tank at the front once it has a factory", () => {
    expect(
      drive(
        () => ai.maybeSpawnTank(),
        () => nation.unitCount(UnitType.Tank) > 0,
        50,
      ),
    ).toBe(false);
    nation.buildUnit(UnitType.Factory, game.ref(15, 15), {});
    expect(
      drive(
        () => ai.maybeSpawnTank(),
        () => nation.unitCount(UnitType.Tank) > 0,
      ),
    ).toBe(true);
    const tank = nation.units(UnitType.Tank)[0];
    // Parked at the border with the enemy.
    expect(game.manhattanDist(tank.tile(), game.ref(39, 25))).toBeLessThan(40);
  });

  test("never builds past its cap", () => {
    nation.buildUnit(UnitType.Factory, game.ref(15, 15), {});
    drive(
      () => ai.maybeSpawnTank(),
      () => false,
      300,
    );
    // 900 tiles: one tank plus one per 200 tiles.
    expect(nation.unitCount(UnitType.Tank)).toBeLessThanOrEqual(5);
    expect(nation.unitCount(UnitType.Tank)).toBeGreaterThan(0);
  });

  test("fields fighter jets once it has an airport", () => {
    nation.buildUnit(UnitType.Airport, game.ref(15, 15), {});
    expect(
      drive(
        () => ai.maybeSpawnJet(),
        () => nation.unitCount(UnitType.FighterJet) > 0,
      ),
    ).toBe(true);
    drive(
      () => ai.maybeSpawnJet(),
      () => false,
      300,
    );
    expect(nation.unitCount(UnitType.FighterJet)).toBeLessThanOrEqual(2);
  });

  test("an idle tank is sent to the hostile border", () => {
    nation.buildUnit(UnitType.Factory, game.ref(15, 15), {});
    const tank = nation.buildUnit(UnitType.Tank, game.ref(12, 12), {
      patrolTile: game.ref(12, 12),
    });
    drive(
      () => ai.commandTanks(),
      () => (tank.warshipState().patrolTile ?? 0) !== game.ref(12, 12),
    );
    const patrol = tank.warshipState().patrolTile!;
    expect(game.owner(patrol)).toBe(nation);
    // On the border facing the enemy, not somewhere inland.
    expect(game.x(patrol)).toBe(39);
  });

  test("a jet chases an enemy cargo plane in range", () => {
    const jet = nation.buildUnit(UnitType.FighterJet, game.ref(15, 15), {
      patrolTile: game.ref(15, 15),
    });
    const dest = enemy.buildUnit(UnitType.Airport, game.ref(65, 35), {});
    const plane = enemy.buildUnit(UnitType.CargoPlane, game.ref(50, 40), {
      targetUnit: dest,
    });
    drive(
      () => ai.commandJets(),
      () => jet.warshipState().patrolTile === plane.tile(),
    );
    expect(jet.warshipState().patrolTile).toBe(plane.tile());
  });

  test("a real nation does it on its own, deterministically", () => {
    nation.buildUnit(UnitType.City, game.ref(15, 15), {});
    nation.buildUnit(UnitType.Factory, game.ref(16, 15), {});
    const exec = new NationExecution(
      "game",
      new Nation(new Cell(20, 20), nation.info()),
    );
    exec.init(game);
    for (let i = 0; i < 3000; i++) {
      exec.tick(game.ticks());
      game.executeNextTick();
    }
    expect(nation.unitCount(UnitType.Airport)).toBeGreaterThan(0);
    expect(nation.unitCount(UnitType.Tank)).toBeGreaterThan(0);
  });
});

describe("Zombie horde balance", () => {
  test("attacking the horde costs far more than attacking a tribe", async () => {
    const g = await setup("plains", {}, []);
    const cfg = g.config() as EngineConfig;
    const input = (isZombie: boolean) => ({
      terrain: 0,
      attackTroops: 1000,
      attacker: { type: PlayerType.Human, numTiles: 100 },
      defender: {
        type: PlayerType.Bot,
        numTiles: 100,
        troops: 1000,
        isTraitor: false,
        isDisconnectedTeammate: false,
        isZombie,
      },
      defenderHasDefensePost: false,
      falloutRatio: null,
      borderSize: 10,
    });
    const real = (i: ReturnType<typeof input>) =>
      EngineConfig.prototype.attackLogic.call(cfg, i);
    const tribe = real(input(false));
    const horde = real(input(true));
    expect(horde.attackerTroopLoss).toBeGreaterThan(
      tribe.attackerTroopLoss * 3,
    );
    expect(horde.tickFraction).toBeGreaterThan(tribe.tickFraction);
  });
});
