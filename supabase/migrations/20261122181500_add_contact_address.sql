alter table public.portal_contacts
  add column address_ciphertext text,
  add column address_iv text;
