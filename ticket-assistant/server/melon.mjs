// Public product-page markup checked against Melon product 213480 on 2026-09-10.
// These selectors cover the date, performance time and booking entry only.
export function melonSelectors(config) {
  const day = config.date.replaceAll('-', '');
  const [hours = '', minutes = ''] = (config.time || '').split(':');
  const hour = hours.startsWith('0') ? '0?' + Number(hours) : hours;
  const minute = minutes.startsWith('0') ? '0?' + Number(minutes) : minutes;
  const clock = `^\\s*(?:${hour}\\s*:\\s*${minutes}|${hour}\\s*시\\s*${minute}\\s*분)(?=\\s|선예매|매진|$)`;
  return {
    date: [`#list_date li.item_date[data-perfday="${day}"] > button`, `button.ticketCalendarBtn[data-perfday="${day}"]`],
    time: [`#list_time li.item_time[data-perfday="${day}"] > button:has(> span.txt:text-matches(${JSON.stringify(clock)}))`],
    entry: ['#ticketReservation_Btn'],
  };
}

// A date in a later month can already be present in the site's hidden list.
// Use the site's own list-view control; never alter the DOM or submit an API call.
export async function revealMelonDate(frames, config, guard = () => {}) {
  const selectors = melonSelectors(config).date;
  for (const frame of frames) {
    for (const selector of selectors) {
      const matches = frame.locator(selector);
      for (let i = 0, count = await matches.count(); i < count; i++) {
        if (await matches.nth(i).isVisible() && await matches.nth(i).isEnabled()) return;
      }
    }
  }
  const toggles = [];
  for (const frame of frames) {
    const matches = frame.locator('.type_list:not(.show)');
    for (let i = 0, count = await matches.count(); i < count; i++) {
      if (await matches.nth(i).isVisible() && await matches.nth(i).isEnabled()) toggles.push(matches.nth(i));
    }
  }
  if (toggles.length === 1) {
    guard();
    await toggles[0].click({ timeout: 4000 });
    guard();
  }
}
