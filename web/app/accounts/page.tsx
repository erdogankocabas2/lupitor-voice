import { db } from "@/lib/supabase";
import { usd } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = {
  id: string; full_name: string; phone: string; dob: string; zip_code: string; ssn_last4: string;
  balance: number; days_past_due: number; portfolio: string; timezone: string; product: string;
};

export default async function AccountsPage() {
  const { data } = await db().from("accounts").select("*").order("created_at");
  const accounts = (data ?? []) as Row[];
  const rules = await Promise.all(
    accounts.map(async (a) => {
      const { data: r } = await db().rpc("can_contact", { p_account_id: a.id });
      return (Array.isArray(r) ? r[0] : r) as { allowed: boolean; reason: string } | null;
    }),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted">Fictional Goldman Stanley customers. Their identity details are shown so you can test verification.</p>
        </div>
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>Customer</th><th>Phone</th><th>Balance</th><th>Days past due</th><th>Portfolio</th>
              <th>Test identity</th><th>Can we call now?</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a, i) => (
              <tr key={a.id}>
                <td><strong>{a.full_name}</strong><div className="muted small">{a.product}</div></td>
                <td className="num">{a.phone}<div className="muted small">{a.timezone}</div></td>
                <td className="num">{usd(a.balance)}</td>
                <td className="num">{a.days_past_due}</td>
                <td>{a.portfolio}</td>
                <td className="num small">Born {a.dob}<br />ZIP {a.zip_code}<br />SSN last 4 {a.ssn_last4}</td>
                <td>{rules[i]?.allowed ? <span className="pill ok">Yes</span> : <span className="pill bad">No</span>}
                  {!rules[i]?.allowed && <div className="muted small">{rules[i]?.reason}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginTop: 16 }}>
        Settlement ladders and floors are owned by collections risk in the offer_policies table. They are not shown
        here and cannot be changed from agent settings.
      </p>
    </>
  );
}
