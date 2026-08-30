import { useEffect, useState } from 'react';

/**
 * Мост между шиной и React: события приходят снаружи, а перерисовкой
 * управляет React. Без него пришлось бы либо звать render() на каждое
 * событие, либо тянуть шину внутрь компонентов — и то и другое сделало бы
 * экраны непроверяемыми без живого апгрейда.
 */
export function App({ subscribe, initialState, render }) {
  const [state, setState] = useState(initialState);
  useEffect(() => subscribe(setState), [subscribe]);
  return render(state);
}
