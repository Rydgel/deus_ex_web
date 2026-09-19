"""Execute AActor::Tick's original main/blend animation phases, unchanged.

Entry 103a1bf0 supplies the outer Tick eligibility and simulated-pawn result;
exit 103a1fd2 precedes movement/script/physics. Function lookup/ProcessEvent
are explicit leaves with ordered callback mutations. Mesh sequence lookup and
all animation instructions execute from the hash-checked original Engine.dll.
"""
import importlib.util
import json
from pathlib import Path
import sys
from unicorn.x86_const import UC_X86_REG_EAX, UC_X86_REG_EBP, UC_X86_REG_EDI, UC_X86_REG_EIP, UC_X86_REG_ESI, UC_X86_REG_ESP

spec = importlib.util.spec_from_file_location('animation', Path(__file__).with_name('native-animation-oracle.py'))
animation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(animation)

BLENDS = {'AnimSequence': 0x68, 'AnimFrame': 0x78, 'AnimRate': 0x88,
          'TweenRate': 0x98, 'AnimLast': 0x23c, 'AnimMinRate': 0x24c, 'OldAnimRate': 0x25c}


class Probe(animation.Probe):
    def __init__(self, root):
        super().__init__(root)
        self.locals = self.alloc(0x100) + 0x80
        self.state = self.alloc(0x30)
        self.actor_vtable = self.alloc(0x20)
        self.write(self.actor_vtable + 0x10, 'I', self.stub('ProcessEvent', b'\xc2\x0c\x00'))
        self.write(0x10599ed4, 'I', self.stub('FindFunction', b'\xc2\x08\x00'))
        self.write(0x10599a88, 'I', self.stub('FindFunctionChecked', b'\xc2\x08\x00'))

    def set_actor(self, values):
        for key, offset in animation.FIELDS.items():
            if key in values:
                self.write(self.actor + offset, 'I' if key == 'AnimSequence' else 'f',
                           self.name(values[key]) if key == 'AnimSequence' else float(values[key]))
        for key, offset, fmt in [('animFlags', 0x28, 'I'), ('RemoteRole', 0x32, 'B')]:
            if key in values:
                self.write(self.actor + offset, fmt, values[key])
        if 'Velocity' in values:
            self.write(self.actor + 0x144, '3f', *values['Velocity'])
        if 'latentAction' in values:
            self.write(self.state + 0x24, 'I', values['latentAction'])
        if 'isWeapon' in values:
            self.write(self.actor + 0x24, 'I', 0x1057c3f8 if values['isWeapon'] else 0)
        for key, offset in [('simAnim', 0x22c)]:
            for i, component in enumerate(['frame', 'rate', 'tween', 'last']):
                if component in values.get(key, {}):
                    self.write(self.actor + offset + i * 4, 'f', float(values[key][component]))
        for i, blend in enumerate(values.get('blends', [])):
            for key, offset in BLENDS.items():
                if key in blend:
                    self.write(self.actor + offset + i * 4, 'I' if key == 'AnimSequence' else 'f',
                               self.name(blend[key]) if key == 'AnimSequence' else float(blend[key]))
            for j, component in enumerate(['frame', 'rate', 'tween', 'last']):
                if component in blend.get('simAnim', {}):
                    self.write(self.actor + 0x26c + i * 16 + j * 4, 'f', float(blend['simAnim'][component]))

    def on_instruction(self, cpu, address, size, data):
        if address == 0x103a1fd2:
            cpu.reg_write(UC_X86_REG_EIP, self.done)
            cpu.emu_stop()
            return
        name = self.stub_names.get(address)
        stack = cpu.reg_read(UC_X86_REG_ESP)
        if name in ['FindFunction', 'FindFunctionChecked']:
            fname, scope = self.read(stack + 4, '2I')
            assert scope == 0
            text = self.name_text[fname]
            found = name == 'FindFunctionChecked' or text.lower() not in self.missing
            self.events.append({'op': name, 'name': text, 'found': found})
            cpu.reg_write(UC_X86_REG_EAX, fname + 0x30000000 if found else 0)
            return
        if name == 'ProcessEvent':
            function, params, result = self.read(stack + 4, '3I')
            assert params == result == 0
            text = self.name_text[function - 0x30000000]
            self.events.append({'op': name, 'name': text,
                                'frameBits': self.read(self.actor + 0x58, 'I')[0],
                                'rateBits': self.read(self.actor + 0x5c, 'I')[0],
                                'animFlags': self.read(self.actor + 0x28, 'I')[0]})
            if self.callback_index < len(self.callbacks):
                callback = self.callbacks[self.callback_index]
                if callback['event'].lower() == text.lower():
                    self.set_actor(callback['actor'])
                    self.callback_index += 1
            return
        super().on_instruction(cpu, address, size, data)

    def setup(self, sample):
        self.names, self.name_text = {'none': 0}, ['None']
        self.events, self.callback_index = [], 0
        self.callbacks = sample.get('callbacks', [])
        self.missing = {name.lower() for name in sample.get('missingFunctions', [])}
        self.cpu.mem_write(self.actor, b'\0' * 0x400)
        self.cpu.mem_write(self.state, b'\0' * 0x30)
        self.write(self.actor, 'I', self.actor_vtable)
        self.write(self.actor + 0xc, 'I', self.state)
        self.write(self.actor + 0x174, 'I', 0 if sample.get('noMesh') else self.mesh)
        self.set_actor(sample.get('actor', {}))
        sequences = sample.get('sequences', [])
        seq_data = self.alloc(max(32, len(sequences) * 32))
        for i, seq in enumerate(sequences):
            notifies = seq.get('notifies', [])
            notify_data = self.alloc(max(8, len(notifies) * 8))
            for j, notify in enumerate(notifies):
                self.write(notify_data + j * 8, 'fI', float(notify['time']), self.name(notify['name']))
            self.write(seq_data + i * 32, '4If3I', self.name(seq['name']), 0,
                       seq.get('startFrame', 0), seq.get('numFrames', 4), seq.get('rate', 10),
                       notify_data, len(notifies), len(notifies))
        self.write(self.mesh + 0x84, '3I', seq_data, len(sequences), len(sequences))
        self.write(0x105836e0, 'I', self.name('AnimEnd'))
        for callback in self.callbacks:
            for state in [callback['actor'], *callback['actor'].get('blends', [])]:
                if 'AnimSequence' in state:
                    self.name(state['AnimSequence'])

    def run(self, sample):
        self.setup(sample)
        self.write(self.locals - 0x20, 'I', bool(sample.get('simulatedPawn')))
        self.write(self.locals + 8, 'f', float(sample['seconds']))
        self.cpu.reg_write(UC_X86_REG_EBP, self.locals)
        self.cpu.reg_write(UC_X86_REG_ESI, self.actor)
        self.cpu.reg_write(UC_X86_REG_EDI, 0)
        before = bytes(self.cpu.mem_read(self.actor, 0x2ac)).hex()
        self.call(0x103a1bf0, self.actor, b'')
        return {'name': sample['name'], 'before': before,
                'after': bytes(self.cpu.mem_read(self.actor, 0x2ac)).hex(),
                'remainingBits': self.read(self.locals - 0x14, 'I')[0],
                'iterations': self.read(self.locals - 0x24, 'I')[0],
                'latentAction': self.read(self.state + 0x24, 'I')[0],
                'callbacks': self.callback_index, 'names': self.name_text, 'events': self.events}


if __name__ == '__main__':
    probe = Probe(Path(sys.argv[1]))
    print(json.dumps({'hashes': animation.native.HASHES,
                      'cases': [probe.run(case) for case in json.load(sys.stdin)]}))
