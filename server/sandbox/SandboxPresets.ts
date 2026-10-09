/** Built-in positions offered by the editor. Each is checked by test/server/sandbox/SandboxPresets.spec.ts. */

export interface ISandboxPreset {
    id: string;
    title: string;
    description: string;
    text: string;
}

export const sandboxPresets: ISandboxPreset[] = [
    {
        id: 'krennic-cad-bane',
        title: 'Krennic + Cad Bane (Plot)',
        description: 'Deploy Director Krennic with Cad Bane in your resources. Krennic\'s When Deployed and Cad Bane\'s Plot trigger together and P1 orders them. ' +
          'Plot first: Cad Bane\'s When Played resolves (nested) before Krennic, so it can only defeat the already-damaged Battlefield Marine; Krennic can then use Cad Bane\'s 4 power or the AT-ST\'s 6, ' +
          'but Consular Security Force (7 HP) survives. Krennic first: the AT-ST deals 6 to Consular Security Force (1 HP left), then Cad Bane\'s When Played defeats it.',
        text: [
            '# Krennic + Cad Bane (Plot)',
            'phase: action',
            'initiative: P1',
            '',
            '[P1]',
            'leader: Director Krennic, Amidst My Achievement',
            'base: Dagobah Swamp',
            'ground: AT-ST',
            'resource: Cad Bane, Impressed Now?',
            'resource: 6x Underworld Thug',
            'hand: Battlefield Marine',
            'deck: Pyke Sentinel',
            'deck: 5x Underworld Thug',
            '',
            '[P2]',
            'leader: Luke Skywalker, Faithful Friend',
            'base: Administrator\'s Tower',
            'ground: Consular Security Force',
            'ground: Battlefield Marine [damage 1]',
            'resource: 4x Underworld Thug',
            'hand: Wampa',
            'deck: 5x Underworld Thug',
            '',
        ].join('\n'),
    },
    {
        id: 'iden-plot-krayt',
        title: 'Iden Versio + two Plots vs Krayt Dragon',
        description: 'Deploy Iden Versio with Dogmatic Shock Squad and Cad Bane in resources. Three triggers to order; with Krayt Dragon in play, P2 decides inside the nested layers.',
        text: [
            '# Iden Versio + two Plots vs Krayt Dragon',
            'phase: action',
            'initiative: P1',
            '',
            '[P1]',
            'leader: Iden Versio, Inferno Squad Commander',
            'base: Dagobah Swamp',
            'resource: Dogmatic Shock Squad',
            'resource: Cad Bane, Impressed Now?',
            'resource: 14x Wampa',
            'deck: Pyke Sentinel',
            'deck: Moisture Farmer',
            'deck: 4x Underworld Thug',
            '',
            '[P2]',
            'leader: Luke Skywalker, Faithful Friend',
            'base: Administrator\'s Tower',
            'ground: Battlefield Marine [damage 1]',
            'ground: Krayt Dragon',
            'resource: 4x Underworld Thug',
            'deck: 5x Underworld Thug',
            '',
        ].join('\n'),
    },
    {
        id: 'empty-board',
        title: 'Empty board, 10 ready resources each',
        description: 'Leaders and bases only, with 10 ready resources and a small deck each.',
        text: [
            '# Empty board',
            'phase: action',
            'initiative: P1',
            '',
            '[P1]',
            'leader: Darth Vader, Dark Lord of the Sith',
            'base: Kestro City',
            'resource: 10x Underworld Thug',
            'deck: 10x Underworld Thug',
            '',
            '[P2]',
            'leader: Luke Skywalker, Faithful Friend',
            'base: Administrator\'s Tower',
            'resource: 10x Underworld Thug',
            'deck: 10x Underworld Thug',
            '',
        ].join('\n'),
    },
];
