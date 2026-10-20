"""Replay of calls Play recorded (O3), shared by the native-*-oracle.py drivers' `--o3` mode (docs/stage-5-exit-criteria.md "O3").

An oracle driver runs the original body from a recorded call's entry state and constants, and this helper answers its service calls (MoveActor, line queries,
the nested native bodies the driver stubs at their addresses, script events) from the events Play recorded for the same call, in order. Every service call the
original makes is logged as {k, args, pre} (`pre` is the pawn's tracked state at that moment) for the caller to compare with Play's; after the service the
tracked state Play had is installed, so what the world did to the pawn is an input and what the body did is the original's. A call the original makes that
Play did not (a different service, an extra one) ends the replay as a divergence, reported with both sides.

Nothing here decides an outcome: the comparison is bit-exact equality of the logged events and the final state with Play's (scripts/validate-stage5-o3.mjs).
"""
import struct


class Divergence(Exception):
    pass


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


# The tracked state of a pawn in the oracles' memory layout (Engine.dll offsets used by native-falling-oracle.py and its derivatives).
PHYSICS, BASE, LOCATION, OLD_LOCATION, VELOCITY, ACCELERATION = 0x30, 0xc4, 0x114, 0x12c, 0x144, 0x150
MOTION, PAWN_FLAGS, MOVE_TIMER, LANDING_COUNTER = 0x1ec, 0x318, 0x348, 0x324
JUST_TELEPORTED, IS_PLAYER, IS_WALKING, HIT_SLOPED_WALL, CAN_JUMP = 0x100, 0x2, 0x10, 0x20, 0x1000


def stand_in(native, info):
    """A native actor object for a recorded actor: the class chain the original's IsA walks read, and the few fields the bodies read of a hit actor."""
    pointer = native.alloc(0x1000)
    if info['isPlayerPawn']:
        cls = 0x1058c160
    elif info['isPawn']:
        cls = 0x1058c660
    else:
        cls = (getattr(native, 'ancestry', {}).get('decoration') or getattr(native, 'decoration_class', None)) if info['isDecoration'] else None
        if cls is None:
            cls = native.alloc(0x40)  # a script class with no native ancestry: every IsA(ALevelInfo/APawn/ADecoration) is false
            native.write(cls + 0x28, 'I', 0)
    native.write(pointer + 0x24, 'I', cls)
    native.write(pointer + 0x28, 'I', 0x800000 if info['isPawn'] or info['isPlayerPawn'] else 0)  # bIsPawn
    if info.get('mass') is not None:
        native.write(pointer + 0x1f4, 'f', info['mass'])
    if info['isDecoration']:
        native.write(pointer + 0x31c, 'B', 1 if info['pushable'] else 0)  # Decoration.bPushable, which stepUp tests (0x103ce624)
    return pointer


class Replay:
    def __init__(self, native, case, world):
        """`world` is the native stand-in of the recorded id 'world'; the case's `actors` describe every other id."""
        self.n = native
        self.recorded = case['events']
        self.actors = {'world': world}
        for key, info in case.get('actors', {}).items():
            self.actors[int(key)] = stand_in(native, info)
        self.kind = case.get('kind', 'pawn')  # 'pawn': a pawn view; 'host': a non-Pawn actor (a decoration)
        self.index = 0
        self.events = []

    def pointer(self, actor):
        if actor is None:
            return 0
        if actor not in self.actors:
            raise Divergence(f'recorded actor {actor!r} has no native stand-in')
        return self.actors[actor]

    def actor(self, pointer):
        if pointer == 0:
            return None
        for key, value in self.actors.items():
            if value == pointer:
                return key
        raise Divergence(f'native passed an unknown actor pointer {pointer:#x}')

    def snapshot(self):
        n = self.n
        motion = n.read(n.pawn + MOTION, 'I')[0]
        state = {'position': list(n.read(n.pawn + LOCATION, '3f')), 'velocity': list(n.read(n.pawn + VELOCITY, '3f')),
                 'acceleration': list(n.read(n.pawn + ACCELERATION, '3f')), 'oldLocation': list(n.read(n.pawn + OLD_LOCATION, '3f')),
                 'physics': n.read(n.pawn + PHYSICS, 'B')[0], 'justTeleported': bool(motion & JUST_TELEPORTED)}
        if self.kind == 'host':
            state.update(landingCounter=n.read(n.pawn + LANDING_COUNTER, 'i')[0], base=self.actor(n.read(n.pawn + BASE, 'I')[0]))
            return state
        flags = n.read(n.pawn + PAWN_FLAGS, 'I')[0]
        state.update(isWalking=bool(flags & IS_WALKING), hitSlopedWall=bool(flags & HIT_SLOPED_WALL), canJump=bool(flags & CAN_JUMP),
                     moveTimer=n.read(n.pawn + MOVE_TIMER, 'f')[0], base=self.actor(n.read(n.pawn + BASE, 'I')[0]))
        return state

    def install(self, state):
        n = self.n
        n.write(n.pawn + LOCATION, '3f', *state['position'])
        n.write(n.pawn + VELOCITY, '3f', *state['velocity'])
        n.write(n.pawn + ACCELERATION, '3f', *state['acceleration'])
        n.write(n.pawn + OLD_LOCATION, '3f', *state['oldLocation'])
        n.write(n.pawn + PHYSICS, 'B', state['physics'])
        motion = n.read(n.pawn + MOTION, 'I')[0] & ~JUST_TELEPORTED
        n.write(n.pawn + MOTION, 'I', motion | (JUST_TELEPORTED if state['justTeleported'] else 0))
        n.write(n.pawn + BASE, 'I', self.pointer(state['base']))
        if self.kind == 'host':
            n.write(n.pawn + LANDING_COUNTER, 'i', state['landingCounter'])
            return
        flags = n.read(n.pawn + PAWN_FLAGS, 'I')[0] & ~(IS_WALKING | HIT_SLOPED_WALL | CAN_JUMP)
        n.write(n.pawn + PAWN_FLAGS, 'I', flags | (IS_WALKING if state['isWalking'] else 0) | (HIT_SLOPED_WALL if state['hitSlopedWall'] else 0)
                | (CAN_JUMP if state['canJump'] else 0))
        n.write(n.pawn + MOVE_TIMER, 'f', state['moveTimer'])

    def take(self, kind, args):
        """The native made a `kind` service call with `args`: log it with the pawn's state, and return Play's recorded call at this point of the sequence."""
        self.events.append({'k': kind, 'args': args, 'pre': self.snapshot()})
        if self.index >= len(self.recorded):
            raise Divergence(f'the native made a {kind} call (#{self.index}) that Play did not')
        recorded = self.recorded[self.index]
        self.index += 1
        if recorded['k'] != kind:
            raise Divergence(f'the native made a {kind} call (#{self.index - 1}) where Play made a {recorded["k"]} call')
        return recorded

    def done(self):
        if self.index < len(self.recorded):
            raise Divergence(f'Play made {len(self.recorded) - self.index} more calls ({self.recorded[self.index]["k"]} next) than the native')
