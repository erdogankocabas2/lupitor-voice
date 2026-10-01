-- Seed data. All people are fictional.
-- Before testing by phone, replace +900000000001..3 with your own number in E.164
-- (e.g. +905321234567). Those test accounts use Europe/Istanbul so the calling-hours
-- rule matches your local day.

insert into offer_policies (portfolio, ladder_pct, max_concessions_per_call, plan_max_months, plan_min_installment, plan_total_pct)
values
  ('prime',    '{1.00, 0.90, 0.82, 0.75}', 2, 12, 50.00, 1.00),
  ('subprime', '{1.00, 0.85, 0.72, 0.60}', 3, 18, 25.00, 1.00)
on conflict (portfolio) do nothing;

insert into accounts (full_name, phone, dob, zip_code, ssn_last4, account_last4, product, balance, days_past_due, portfolio, timezone) values
  ('Dana Whitfield',   '+905326382424', '1988-03-14', '10027', '4417', '8812', 'credit card',   4120.60,  96, 'prime',    'Europe/Istanbul'),
  ('Marcus Oyelaran',  '+900000000002', '1979-11-02', '60614', '9023', '1150', 'personal loan', 12875.00, 142, 'subprime', 'Europe/Istanbul'),
  ('Priya Raman',      '+900000000003', '1995-07-21', '94110', '3381', '6604', 'credit card',   865.40,   48, 'prime',    'Europe/Istanbul'),
  ('Tom Kessler',      '+15550100004',  '1969-01-30', '30307', '7712', '2290', 'credit card',   2310.00,  75, 'prime',    'America/New_York'),
  ('Lucia Ferreira',   '+15550100005',  '1983-05-09', '85004', '5560', '4471', 'personal loan', 6400.00, 120, 'subprime', 'America/Phoenix');

with a as (
  insert into agents (name, description, template, handles_inbound)
  values ('Goldman Stanley Collections', 'Outbound and inbound recovery for past-due card and loan accounts', 'collections', true)
  returning id
)
insert into agent_versions (agent_id, version, config, notes, traffic_weight)
select id, 1, jsonb_build_object(
  'persona_name', 'Alex',
  'company', 'Goldman Stanley',
  'callback_number', '+1 555 010 0199',
  'llm', 'openai/gpt-4.1-mini',
  'stt', 'deepgram/nova-3:en',
  'tts', 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
  'extra_instructions', ''
), 'Initial version', 100 from a;

with a as (
  insert into agents (name, description, template, handles_inbound)
  values ('Front desk', 'General purpose receptionist, used to show the generic template', 'generic', false)
  returning id
)
insert into agent_versions (agent_id, version, config, notes, traffic_weight)
select id, 1, jsonb_build_object(
  'persona_name', 'Sam',
  'company', 'Goldman Stanley',
  'greeting', 'Hi, you''ve reached Goldman Stanley. How can I help today?',
  'llm', 'openai/gpt-4.1-mini',
  'stt', 'deepgram/nova-3:en',
  'tts', 'cartesia/sonic-2:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
  'extra_instructions', 'Answer general questions about branch hours (9am to 5pm, Monday to Friday). For anything about an account, say a specialist will call back.'
), 'Initial version', 100 from a;
