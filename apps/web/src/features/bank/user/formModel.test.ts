import { describe, expect, test } from 'bun:test';
import { UserImportInputSchema, UserPatchSchema, type CellOffset } from '@hsw-editor/bank';
import {
  addTags,
  capacityIssue,
  dimKeySuggestions,
  dimRowIssue,
  editSubmitMode,
  effectiveGeometry,
  EMPTY_FORM,
  fitsToolsOf,
  formFromInput,
  formIssues,
  hasIssues,
  meshFormatOfName,
  removeTag,
  settingsEqual,
  toImportInput,
  toPatch,
  type FitsEntry,
  type FormState,
} from './formModel.ts';

const A: CellOffset = { dCol: 0, dRow2: 0 };
const B: CellOffset = { dCol: 0, dRow2: 2 };
const C: CellOffset = { dCol: 1, dRow2: 1 };
const detected = { footprint: [A, B], mountingCells: [B] };

const named: FormState = { ...EMPTY_FORM, nameEn: ' Pliers holder ', category: 'holders/pliers' };

describe('toImportInput: untouched fields are omitted', () => {
  test('a pristine form sends names, category and tags only', () => {
    const input = toImportInput(named, effectiveGeometry(named, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input).toEqual({
      uploadId: 'up-abcdefgh',
      name: { en: 'Pliers holder' },
      category: 'holders/pliers',
      tags: { ru: [], en: [] },
      toolClasses: [],
      fitsTool: [],
    });
    expect(UserImportInputSchema.safeParse(input).success).toBe(true);
  });

  test('chosen settings are sent, only those', () => {
    const form: FormState = { ...named, settings: { unit: 'cm' } };
    const input = toImportInput(form, effectiveGeometry(form, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input.settings).toEqual({ unit: 'cm' });
  });

  test('an edited footprint goes out together with the mounting that fits it', () => {
    const form: FormState = { ...named, footprint: [A, B, C] };
    const input = toImportInput(form, effectiveGeometry(form, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input.footprint).toEqual([A, B, C]);
    expect(input.mounting).toEqual({ kind: 'hex-plug', cells: [B] });
  });

  test('shrinking the footprint drops the pegs outside it from what is sent', () => {
    const form: FormState = { ...named, footprint: [A] };
    const geometry = effectiveGeometry(form, detected);
    expect(geometry.mountingCells).toEqual([]);
    expect(hasIssues(formIssues(form, geometry))).toBe(true);
  });

  test('only a changed mounting kind sends mounting, not the footprint', () => {
    const form: FormState = { ...named, mountingKind: 'clip' };
    const input = toImportInput(form, effectiveGeometry(form, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input.footprint).toBeUndefined();
    expect(input.mounting).toEqual({ kind: 'clip', cells: [B] });
  });

  test('replaceId is passed through for an edit', () => {
    const input = toImportInput(named, effectiveGeometry(named, detected), {
      uploadId: 'up-abcdefgh',
      replaceId: 'my-holder',
    });
    expect(input.replaceId).toBe('my-holder');
  });

  test('names: both languages typed are both sent, blanks are not', () => {
    const form: FormState = { ...named, nameRu: 'Держатель', nameEn: '  ' };
    const input = toImportInput(form, effectiveGeometry(form, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input.name).toEqual({ ru: 'Держатель' });
  });
});

describe('fitsTool', () => {
  const entry = (patch: Partial<FitsEntry>): FitsEntry => ({
    uid: 1,
    toolClass: 'pliers',
    capacity: '',
    dims: [],
    ...patch,
  });

  test('rows become ranges, the union of classes is sent as toolClasses', () => {
    const form: FormState = {
      ...named,
      fits: [
        entry({ capacity: '2', dims: [{ key: ' width ', min: '5', max: '12,5' }] }),
        entry({ uid: 2, toolClass: 'snips' }),
        entry({ uid: 3, toolClass: 'pliers' }),
      ],
    };
    const input = toImportInput(form, effectiveGeometry(form, detected), {
      uploadId: 'up-abcdefgh',
    });
    expect(input.toolClasses).toEqual(['pliers', 'snips']);
    expect(input.fitsTool).toEqual([
      { toolClass: 'pliers', capacity: 2, dims: { width: { min: 5, max: 12.5 } } },
      { toolClass: 'snips' },
    ]);
  });

  test('entries without a class and invalid rows are not sent', () => {
    const entries = [
      entry({ toolClass: '' }),
      entry({
        dims: [
          { key: 'width', min: '9', max: '2' },
          { key: '', min: '', max: '' },
        ],
      }),
    ];
    expect(fitsToolsOf(entries)).toEqual([{ toolClass: 'pliers' }]);
  });

  test('range validation: key, numbers and min <= max', () => {
    expect(dimRowIssue({ key: '', min: '', max: '' })).toBeNull();
    expect(dimRowIssue({ key: 'width', min: '1', max: '2' })).toBeNull();
    expect(dimRowIssue({ key: 'width', min: '2', max: '2' })).toBeNull();
    expect(dimRowIssue({ key: 'width', min: '3', max: '2' })).toBe('order');
    expect(dimRowIssue({ key: 'width', min: '', max: '2' })).toBe('number');
    expect(dimRowIssue({ key: 'width', min: 'a', max: '2' })).toBe('number');
    expect(dimRowIssue({ key: ' ', min: '1', max: '2' })).toBe('key');
  });

  test('capacity must be a positive whole number when given', () => {
    expect(capacityIssue('')).toBeNull();
    expect(capacityIssue('3')).toBeNull();
    expect(capacityIssue('0')).toBe('capacity');
    expect(capacityIssue('1.5')).toBe('capacity');
  });

  test('suggestions are the dim keys other elements use for that class, most used first', () => {
    const elements = [
      {
        fitsTool: [
          { toolClass: 'pliers', dims: { width: { min: 1, max: 2 }, depth: { min: 1, max: 2 } } },
        ],
      },
      { fitsTool: [{ toolClass: 'pliers', dims: { width: { min: 1, max: 2 } } }] },
      { fitsTool: [{ toolClass: 'snips', dims: { blade: { min: 1, max: 2 } } }] },
    ];
    expect(dimKeySuggestions(elements, 'pliers')).toEqual(['width', 'depth']);
    expect(dimKeySuggestions(elements, 'none')).toEqual([]);
  });
});

describe('patch vs re-import', () => {
  test('unchanged settings mean a metadata PATCH', () => {
    expect(editSubmitMode({}, {})).toBe('patch');
    expect(
      editSubmitMode(
        { unit: 'mm', orient: { out: '+z', up: '+y' } },
        { orient: { up: '+y', out: '+z' }, unit: 'mm' },
      ),
    ).toBe('patch');
  });

  test('any changed setting or part needs the job', () => {
    expect(editSubmitMode({}, { unit: 'cm' })).toBe('reimport');
    expect(editSubmitMode({ partId: 'a' }, { partId: 'b' })).toBe('reimport');
    expect(
      editSubmitMode({ orient: { out: '+z', up: '+y' } }, { orient: { out: '+z', up: '+x' } }),
    ).toBe('reimport');
    expect(editSubmitMode({ repair: true }, {})).toBe('reimport');
  });

  test('settingsEqual ignores key order', () => {
    expect(settingsEqual({ anchor: 'origin', unit: 'in' }, { unit: 'in', anchor: 'origin' })).toBe(
      true,
    );
  });

  test('the patch carries metadata and cells, never the mesh settings', () => {
    const form: FormState = { ...named, settings: { unit: 'cm' }, footprint: [A, B] };
    const patch = toPatch(form, effectiveGeometry(form, detected));
    expect('settings' in patch).toBe(false);
    expect('uploadId' in patch).toBe(false);
    expect(patch.footprint).toEqual([A, B]);
    expect(UserPatchSchema.safeParse(patch).success).toBe(true);
  });
});

describe('opening an element for editing', () => {
  test('the stored metadata fills the form; stored geometry counts as chosen', () => {
    const form = formFromInput({
      replaceId: 'my-holder',
      name: { ru: 'Держатель', en: 'Holder' },
      category: 'holders/pliers',
      tags: { ru: ['клещи'], en: ['pliers'] },
      toolClasses: ['pliers', 'snips'],
      fitsTool: [{ toolClass: 'pliers', capacity: 2, dims: { width: { min: 1, max: 4 } } }],
      footprint: [A, B],
      mounting: { kind: 'm3-screw', cells: [B] },
      settings: { unit: 'mm' },
    });
    expect(form.nameRu).toBe('Держатель');
    expect(form.footprint).toEqual([A, B]);
    expect(form.mountingKind).toBe('m3-screw');
    expect(form.settings).toEqual({ unit: 'mm' });
    // A class listed without a hint stays in the union.
    expect(form.fits.map((fit) => fit.toolClass)).toEqual(['pliers', 'snips']);
    expect(form.fits[0]?.dims).toEqual([{ key: 'width', min: '1', max: '4' }]);
    expect(form.fits[0]?.capacity).toBe('2');
  });
});

describe('validation', () => {
  test('a name in either language, a category, and a valid mounting are required', () => {
    const geometry = effectiveGeometry(EMPTY_FORM, detected);
    expect(formIssues(EMPTY_FORM, geometry)).toEqual({
      name: true,
      category: true,
      mounting: false,
      fits: false,
    });
    expect(hasIssues(formIssues(named, effectiveGeometry(named, detected)))).toBe(false);
  });

  test('a panel category needs no pegs', () => {
    const form: FormState = { ...EMPTY_FORM, nameRu: 'Панель', category: 'panels' };
    const geometry = effectiveGeometry(form, { footprint: [A], mountingCells: [] });
    expect(geometry.mountingKind).toBe('none');
    expect(formIssues(form, geometry).mounting).toBe(false);
  });
});

describe('tags and files', () => {
  test('tags are trimmed, split on commas and unique ignoring case', () => {
    expect(addTags(['Pliers'], ' pliers, snips ,, Wire ')).toEqual(['Pliers', 'snips', 'Wire']);
    const same = ['a'];
    expect(addTags(same, 'A')).toBe(same);
    expect(removeTag(['a', 'b'], 'a')).toEqual(['b']);
  });

  test('mesh format by extension, case-insensitive', () => {
    expect(meshFormatOfName('Part.STL')).toBe('stl');
    expect(meshFormatOfName('a.b.glb')).toBe('glb');
    expect(meshFormatOfName('x.3mf')).toBe('3mf');
    expect(meshFormatOfName('x.obj')).toBeNull();
    expect(meshFormatOfName('noextension')).toBeNull();
  });
});
