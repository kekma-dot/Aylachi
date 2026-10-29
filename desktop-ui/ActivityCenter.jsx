import React from 'react';

export default function ActivityCenter({ activities = [] }) {
  const active = activities.filter(activity => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(activity.state)).length;
  return <details className="activity-center">
    <summary>Activity{active ? ` · ${active}` : ''}</summary>
    <aside aria-label="Activity Center">
      <h2>Activity Center</h2>
      {!activities.length && <p>No plugin activity yet.</p>}
      {activities.map(activity => <article key={activity.commandId}>
        <strong>{activity.toolName}</strong><span>{activity.state}</span>
        {activity.reasonCode && <p>{activity.reasonCode}</p>}
        {activity.result !== null && activity.result !== undefined && <pre>{JSON.stringify(activity.result, null, 2)}</pre>}
      </article>)}
    </aside>
  </details>;
}
