/** Wall physics: command, toggle, legend, wall report, tool inspector section, holder badges and the problem sentences. Placeholders use `{name}`. */
import type { FeatureRu } from '../keys.ts';

export const physicsEn = {
  'physics.cmd.check': 'Check wall physics',
  'physics.cmd.seat': 'Seat tools in their holders',
  'physics.seat.button': 'Seat tools',
  'physics.seat.off': 'Physics checks are off: switch them on to seat tools',
  'physics.seat.stale': 'The wall changed while seating: nothing was moved, try again',
  'physics.seat.nothing': 'Every tool already sits where the physics puts it',
  'physics.seat.kept.one':
    '{count} tool could not be seated (no model yet, no free slot or a rotated holder)',
  'physics.seat.kept.other':
    '{count} tools could not be seated (no model yet, no free slot or a rotated holder)',
  'physics.seat.unslotted.one':
    '{count} tool has no slot number: take it off and hang it again to seat it',
  'physics.seat.unslotted.other':
    '{count} tools have no slot number: take them off and hang them again to seat them',
  'physics.seat.done.one': '{count} tool seated in its holder',
  'physics.seat.done.other': '{count} tools seated in their holders',
  'physics.toggle': 'Physics',
  'physics.toggleHint':
    'Mark tools that hang unstably or are awkward to take off with amber stripes',
  'physics.legend.checking': 'Checking physics…',
  'physics.legend.ok': 'Physics OK',
  'physics.legend.count.one': '{count} tool has physics problems',
  'physics.legend.count.other': '{count} tools have physics problems',
  'physics.legend.swatch':
    'Amber diagonal stripes mark a tool that hangs badly; an amber outline marks a warning',

  'physics.panel.title': 'Physics',
  'physics.panel.check': 'Check again',
  'physics.panel.checkFirst': 'Check physics',
  'physics.panel.idle': 'Not checked yet',
  'physics.panel.running': 'Checking…',
  'physics.panel.attention.one': '{count} tool needs attention',
  'physics.panel.attention.other': '{count} tools need attention',
  'physics.panel.allOk': 'All tools hang well',
  'physics.panel.noTools': 'No tool on a holder to check',
  'physics.panel.error': 'Physics check failed: {message}',
  'physics.panel.on': 'on {holder}',
  'physics.panel.rating': 'Rating {percent}%',
  'physics.panel.errorDot': 'Hangs badly',
  'physics.panel.warningDot': 'Needs attention',

  'physics.inspector.title': 'Physics',
  'physics.inspector.none':
    'Not analysed: the tool is not on a holder, or its model is still loading',
  'physics.inspector.ok': 'No physics problems',
  'physics.inspector.hang': 'Hang',
  'physics.inspector.mass': 'Mass',
  'physics.inspector.massValue': '{massG} g',
  'physics.inspector.rest':
    'Leans {tiltDeg}° and rests against the holder walls or leans back on the board',
  'physics.inspector.removal': 'Taking it off',
  'physics.inspector.path': 'Path: {path}',
  'physics.inspector.convenience': 'Convenience {percent}%',
  'physics.hang.stable': 'Stable',
  'physics.hang.marginal': 'Marginal',
  'physics.hang.unstable': 'Unstable',
  'physics.hang.chip': '{status} · {percent}%',
  'physics.removal.free': 'Comes off freely',
  'physics.removal.needs_tilt': 'Needs a tilt',
  'physics.removal.needs_two_hands': 'Needs two hands',
  'physics.removal.blocked': 'Cannot be taken off',

  'physics.path.lift': 'lift',
  'physics.path.pull': 'pull',
  'physics.path.liftPull': 'lift {liftMm} mm, pull',
  'physics.path.tilt': 'tilt {deg}° about {axis}',

  'physics.badge.stable': 'Stable',
  'physics.badge.marginal': 'Marginal',
  'physics.badge.unstable': 'Unstable',
  'physics.badge.awkward': 'Awkward',
  'physics.badge.titleHang': 'Hang: {status}',
  'physics.badge.titleAwkward': 'Awkward to take off',

  'physics.problem.levitating': 'Floats {gapMm} mm above its holder: nothing touches it',
  'physics.problem.levitating.unbounded': 'Floats: nothing under it holds it',
  'physics.problem.penetrates': 'Sunk {depthMm} mm into the holder: it is not seated in the slot',
  'physics.problem.falls': 'Falls: the holder cannot carry it in this pose',
  'physics.problem.tips': 'Tips over: its centre of gravity is not over the support',
  'physics.problem.swings': 'Swings about {swayMm} mm when bumped (up to {swingDeg}°)',
  'physics.problem.slides_off': 'Slides off sideways when bumped',
  'physics.problem.needs_retention':
    'Nothing holds it against a pull: it can be dragged out with a neighbour',
  'physics.problem.wedged':
    'Stuck, not seated: its end is jammed {depthMm} mm into an opening too small for it',
  'physics.problem.protrudes':
    'Sticks out {protrudeMm} mm below its holder: the rack is too shallow for it',
  'physics.problem.overloaded':
    'Too heavy for the holder: {massG} g, it carries up to {maxLoadG} g',
  'physics.problem.removal_blocked': 'Cannot be taken off: blocked by {blockedBy}',
  'physics.problem.removal_blocked.unknown': 'Cannot be taken off: something is in the way',
  'physics.problem.removal_needs_tilt': 'Needs a tilt to take off ({path})',
  'physics.problem.removal_two_hands': 'Needs two hands to take off: {because}',
  'physics.problem.removal_two_hands.unknown': 'Needs two hands to take off',
  'physics.problem.tight_clearance':
    'Tight fit: only {clearanceMm} mm of clearance when taking it off',
  'physics.problem.unknown': 'Physics problem: {code}',
  'physics.because.heavy': 'it is heavy',
  'physics.because.cramped': 'neighbours leave no room for fingers',
  'physics.because.long_lift': 'it has to be lifted a long way',
} as const satisfies Readonly<Record<string, string>>;

export const physicsRu = {
  'physics.cmd.check': 'Проверить физику стены',
  'physics.cmd.seat': 'Посадить инструменты в держатели',
  'physics.seat.button': 'Посадить',
  'physics.seat.off': 'Проверки физики выключены: включите их, чтобы посадить инструменты',
  'physics.seat.stale': 'Стена изменилась во время посадки: ничего не сдвинуто, повторите',
  'physics.seat.nothing': 'Все инструменты уже сидят там, где их ставит физика',
  'physics.seat.kept.one':
    '{count} инструмент не удалось посадить (нет модели, свободного места или держатель повёрнут)',
  'physics.seat.kept.few':
    '{count} инструмента не удалось посадить (нет модели, свободного места или держатель повёрнут)',
  'physics.seat.kept.many':
    '{count} инструментов не удалось посадить (нет модели, свободного места или держатель повёрнут)',
  'physics.seat.kept.other':
    '{count} инструмента не удалось посадить (нет модели, свободного места или держатель повёрнут)',
  'physics.seat.unslotted.one':
    'У {count} инструмента нет номера места: снимите его и повесьте заново, чтобы посадить',
  'physics.seat.unslotted.few':
    'У {count} инструментов нет номера места: снимите их и повесьте заново, чтобы посадить',
  'physics.seat.unslotted.many':
    'У {count} инструментов нет номера места: снимите их и повесьте заново, чтобы посадить',
  'physics.seat.unslotted.other':
    'У {count} инструмента нет номера места: снимите его и повесьте заново, чтобы посадить',
  'physics.seat.done.one': '{count} инструмент посажен в держатель',
  'physics.seat.done.few': '{count} инструмента посажены в держатели',
  'physics.seat.done.many': '{count} инструментов посажено в держатели',
  'physics.seat.done.other': '{count} инструмента посажено в держатели',
  'physics.toggle': 'Физика',
  'physics.toggleHint':
    'Отмечать янтарными полосами инструменты, которые висят неустойчиво или неудобно снимаются',
  'physics.legend.checking': 'Проверка физики…',
  'physics.legend.ok': 'Физика в порядке',
  'physics.legend.count.one': 'У {count} инструмента проблемы с физикой',
  'physics.legend.count.other': 'У {count} инструментов проблемы с физикой',
  'physics.legend.count.few': 'У {count} инструментов проблемы с физикой',
  'physics.legend.count.many': 'У {count} инструментов проблемы с физикой',
  'physics.legend.swatch':
    'Янтарные диагональные полосы отмечают плохо висящий инструмент, янтарный контур — предупреждение',

  'physics.panel.title': 'Физика',
  'physics.panel.check': 'Проверить снова',
  'physics.panel.checkFirst': 'Проверить физику',
  'physics.panel.idle': 'Ещё не проверялось',
  'physics.panel.running': 'Проверка…',
  'physics.panel.attention.one': '{count} инструмент требует внимания',
  'physics.panel.attention.other': '{count} инструментов требуют внимания',
  'physics.panel.attention.few': '{count} инструмента требуют внимания',
  'physics.panel.attention.many': '{count} инструментов требуют внимания',
  'physics.panel.allOk': 'Все инструменты висят хорошо',
  'physics.panel.noTools': 'Нет инструментов на держателях для проверки',
  'physics.panel.error': 'Проверка физики не удалась: {message}',
  'physics.panel.on': 'на «{holder}»',
  'physics.panel.rating': 'Оценка {percent}%',
  'physics.panel.errorDot': 'Висит плохо',
  'physics.panel.warningDot': 'Требует внимания',

  'physics.inspector.title': 'Физика',
  'physics.inspector.none':
    'Не проанализировано: инструмент не на держателе или его модель ещё загружается',
  'physics.inspector.ok': 'Проблем с физикой нет',
  'physics.inspector.hang': 'Подвес',
  'physics.inspector.mass': 'Масса',
  'physics.inspector.massValue': '{massG} г',
  'physics.inspector.rest':
    'Наклоняется на {tiltDeg}° и опирается на стенки держателя или откинут на доску',
  'physics.inspector.removal': 'Снятие',
  'physics.inspector.path': 'Путь: {path}',
  'physics.inspector.convenience': 'Удобство {percent}%',
  'physics.hang.stable': 'Устойчиво',
  'physics.hang.marginal': 'На грани',
  'physics.hang.unstable': 'Неустойчиво',
  'physics.hang.chip': '{status} · {percent}%',
  'physics.removal.free': 'Снимается свободно',
  'physics.removal.needs_tilt': 'Нужен наклон',
  'physics.removal.needs_two_hands': 'Нужны две руки',
  'physics.removal.blocked': 'Снять нельзя',

  'physics.path.lift': 'поднять',
  'physics.path.pull': 'потянуть на себя',
  'physics.path.liftPull': 'поднять на {liftMm} мм, потянуть на себя',
  'physics.path.tilt': 'наклонить на {deg}° вокруг оси {axis}',

  'physics.badge.stable': 'Устойчиво',
  'physics.badge.marginal': 'На грани',
  'physics.badge.unstable': 'Неустойчиво',
  'physics.badge.awkward': 'Неудобно',
  'physics.badge.titleHang': 'Подвес: {status}',
  'physics.badge.titleAwkward': 'Неудобно снимать',

  'physics.problem.levitating': 'Парит в {gapMm} мм над держателем: ничего его не касается',
  'physics.problem.levitating.unbounded': 'Парит: под ним нет опоры',
  'physics.problem.penetrates': 'Утоплен на {depthMm} мм в держатель: не сидит в пазу',
  'physics.problem.falls': 'Падает: держатель не удерживает его в этом положении',
  'physics.problem.tips': 'Опрокидывается: центр тяжести не над опорой',
  'physics.problem.swings': 'Раскачивается примерно на {swayMm} мм при толчке (до {swingDeg}°)',
  'physics.problem.slides_off': 'Соскальзывает вбок при толчке',
  'physics.problem.needs_retention':
    'Ничто не держит его при вытягивании: его можно вытащить вместе с соседом',
  'physics.problem.wedged':
    'Застрял, а не сидит: конец заклинило на {depthMm} мм в отверстии, которое для него мало',
  'physics.problem.protrudes':
    'Торчит на {protrudeMm} мм ниже держателя: стойка для него слишком мелкая',
  'physics.problem.overloaded':
    'Слишком тяжёлый для держателя: {massG} г при допустимых {maxLoadG} г',
  'physics.problem.removal_blocked': 'Снять нельзя: мешает {blockedBy}',
  'physics.problem.removal_blocked.unknown': 'Снять нельзя: что-то мешает',
  'physics.problem.removal_needs_tilt': 'Чтобы снять, нужен наклон ({path})',
  'physics.problem.removal_two_hands': 'Чтобы снять, нужны две руки: {because}',
  'physics.problem.removal_two_hands.unknown': 'Чтобы снять, нужны две руки',
  'physics.problem.tight_clearance': 'Тесно: при снятии зазор всего {clearanceMm} мм',
  'physics.problem.unknown': 'Проблема физики: {code}',
  'physics.because.heavy': 'он тяжёлый',
  'physics.because.cramped': 'соседи не оставляют места для пальцев',
  'physics.because.long_lift': 'его надо поднимать высоко',
} as const satisfies FeatureRu<typeof physicsEn>;
