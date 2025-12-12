-- BluePDM Supplier Database Migration
-- Adds supplier management and part costing for ERP integration (Odoo, etc.)
-- Run this in your Supabase SQL editor AFTER the main schema.sql

-- ===========================================
-- SUPPLIERS (Vendor/Supplier Companies)
-- ===========================================

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  
  -- Basic info
  name TEXT NOT NULL,                  -- Company name (e.g., "McMaster-Carr", "Misumi")
  code TEXT,                           -- Short code for ERP (e.g., "MCMASTER", "MIS")
  
  -- Contact info
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  website TEXT,
  
  -- Address
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'USA',
  
  -- Business terms
  payment_terms TEXT,                  -- e.g., "Net 30", "Net 60", "Due on Receipt"
  default_lead_time_days INT,          -- Default lead time in days
  min_order_value DECIMAL(12,2),       -- Minimum order value
  currency TEXT DEFAULT 'USD',         -- Default currency for this supplier
  shipping_account TEXT,               -- Your shipping account number with them
  
  -- Status
  is_active BOOLEAN DEFAULT true,
  is_approved BOOLEAN DEFAULT false,   -- Approved vendor status
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id),
  
  -- Notes
  notes TEXT,
  
  -- ERP sync
  erp_id TEXT,                         -- ID in Odoo/SAP (for sync)
  erp_synced_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  
  UNIQUE(org_id, code)
);

CREATE INDEX idx_suppliers_org_id ON suppliers(org_id);
CREATE INDEX idx_suppliers_name ON suppliers(name);
CREATE INDEX idx_suppliers_code ON suppliers(code);
CREATE INDEX idx_suppliers_is_active ON suppliers(is_active);
CREATE INDEX idx_suppliers_erp_id ON suppliers(erp_id) WHERE erp_id IS NOT NULL;

-- Full text search on suppliers
CREATE INDEX idx_suppliers_search ON suppliers USING GIN (
  to_tsvector('english', 
    coalesce(name, '') || ' ' || 
    coalesce(code, '') || ' ' || 
    coalesce(notes, '')
  )
);

-- ===========================================
-- PART_SUPPLIERS (Junction table with pricing)
-- ===========================================

CREATE TABLE part_suppliers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  
  -- Supplier's part info
  supplier_part_number TEXT,           -- Supplier's part number/SKU
  supplier_description TEXT,           -- Supplier's description (may differ from ours)
  supplier_url TEXT,                   -- Direct link to product page
  
  -- Pricing (base)
  unit_price DECIMAL(12,4),            -- Price per unit
  currency TEXT DEFAULT 'USD',
  price_unit TEXT DEFAULT 'each',      -- 'each', 'per 100', 'per 1000', 'per ft', etc.
  
  -- Volume pricing (price breaks)
  -- Format: [{"qty": 1, "price": 10.00}, {"qty": 100, "price": 8.50}, {"qty": 1000, "price": 7.00}]
  price_breaks JSONB DEFAULT '[]'::jsonb,
  
  -- Ordering constraints
  min_order_qty INT DEFAULT 1,
  order_multiple INT DEFAULT 1,        -- Must order in multiples of this (e.g., 10)
  
  -- Lead time (overrides supplier default)
  lead_time_days INT,
  
  -- Status
  is_preferred BOOLEAN DEFAULT false,  -- Preferred supplier for this part
  is_active BOOLEAN DEFAULT true,
  
  -- Quality/compliance
  is_qualified BOOLEAN DEFAULT false,  -- Part has been qualified from this supplier
  qualified_at TIMESTAMPTZ,
  qualified_by UUID REFERENCES users(id),
  
  -- Notes
  notes TEXT,
  
  -- ERP sync
  erp_id TEXT,
  erp_synced_at TIMESTAMPTZ,
  
  -- Metadata
  last_price_update TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES users(id),
  
  UNIQUE(file_id, supplier_id)
);

CREATE INDEX idx_part_suppliers_org_id ON part_suppliers(org_id);
CREATE INDEX idx_part_suppliers_file_id ON part_suppliers(file_id);
CREATE INDEX idx_part_suppliers_supplier_id ON part_suppliers(supplier_id);
CREATE INDEX idx_part_suppliers_is_preferred ON part_suppliers(is_preferred) WHERE is_preferred = true;
CREATE INDEX idx_part_suppliers_supplier_part_number ON part_suppliers(supplier_part_number) WHERE supplier_part_number IS NOT NULL;

-- ===========================================
-- ROW LEVEL SECURITY
-- ===========================================

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE part_suppliers ENABLE ROW LEVEL SECURITY;

-- Suppliers: All org members can read, engineers/admins can modify
CREATE POLICY "Users can view org suppliers"
  ON suppliers FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Engineers can insert suppliers"
  ON suppliers FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

CREATE POLICY "Engineers can update suppliers"
  ON suppliers FOR UPDATE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

CREATE POLICY "Admins can delete suppliers"
  ON suppliers FOR DELETE
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role = 'admin'));

-- Part-Suppliers: All org members can read, engineers/admins can modify
CREATE POLICY "Users can view part suppliers"
  ON part_suppliers FOR SELECT
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));

CREATE POLICY "Engineers can manage part suppliers"
  ON part_suppliers FOR ALL
  USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'engineer')));

-- ===========================================
-- HELPER FUNCTIONS
-- ===========================================

-- Function to get the best price for a part at a given quantity
CREATE OR REPLACE FUNCTION get_best_price(
  p_file_id UUID,
  p_quantity INT DEFAULT 1
)
RETURNS TABLE (
  supplier_id UUID,
  supplier_name TEXT,
  supplier_code TEXT,
  supplier_part_number TEXT,
  unit_price DECIMAL(12,4),
  total_price DECIMAL(12,2),
  currency TEXT,
  lead_time_days INT,
  is_preferred BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH pricing AS (
    SELECT 
      ps.supplier_id,
      s.name as supplier_name,
      s.code as supplier_code,
      ps.supplier_part_number,
      ps.currency,
      ps.is_preferred,
      COALESCE(ps.lead_time_days, s.default_lead_time_days) as lead_time_days,
      -- Calculate price based on price breaks
      CASE 
        WHEN ps.price_breaks IS NOT NULL AND jsonb_array_length(ps.price_breaks) > 0 THEN
          (
            SELECT (pb->>'price')::DECIMAL(12,4)
            FROM jsonb_array_elements(ps.price_breaks) pb
            WHERE (pb->>'qty')::INT <= p_quantity
            ORDER BY (pb->>'qty')::INT DESC
            LIMIT 1
          )
        ELSE ps.unit_price
      END as calculated_price
    FROM part_suppliers ps
    JOIN suppliers s ON ps.supplier_id = s.id
    WHERE ps.file_id = p_file_id
      AND ps.is_active = true
      AND s.is_active = true
  )
  SELECT 
    p.supplier_id,
    p.supplier_name,
    p.supplier_code,
    p.supplier_part_number,
    p.calculated_price as unit_price,
    (p.calculated_price * p_quantity)::DECIMAL(12,2) as total_price,
    p.currency,
    p.lead_time_days,
    p.is_preferred
  FROM pricing p
  WHERE p.calculated_price IS NOT NULL
  ORDER BY p.is_preferred DESC, p.calculated_price ASC;
END;
$$ LANGUAGE plpgsql STABLE;

-- Function to calculate BOM cost
CREATE OR REPLACE FUNCTION calculate_bom_cost(
  p_assembly_id UUID,
  p_quantity INT DEFAULT 1
)
RETURNS TABLE (
  assembly_id UUID,
  assembly_name TEXT,
  assembly_part_number TEXT,
  total_cost DECIMAL(12,2),
  currency TEXT,
  component_count INT,
  missing_pricing_count INT
) AS $$
DECLARE
  v_total DECIMAL(12,2) := 0;
  v_missing INT := 0;
  v_component_count INT := 0;
  v_currency TEXT := 'USD';
  v_assembly RECORD;
  v_component RECORD;
  v_best_price RECORD;
BEGIN
  -- Get assembly info
  SELECT id, file_name, part_number INTO v_assembly
  FROM files WHERE id = p_assembly_id;
  
  -- Calculate cost for each component
  FOR v_component IN
    SELECT fr.child_file_id, fr.quantity, f.file_name, f.part_number
    FROM file_references fr
    JOIN files f ON fr.child_file_id = f.id
    WHERE fr.parent_file_id = p_assembly_id
  LOOP
    v_component_count := v_component_count + 1;
    
    -- Get best price for this component
    SELECT * INTO v_best_price 
    FROM get_best_price(v_component.child_file_id, v_component.quantity * p_quantity)
    LIMIT 1;
    
    IF v_best_price IS NOT NULL AND v_best_price.unit_price IS NOT NULL THEN
      v_total := v_total + (v_best_price.unit_price * v_component.quantity * p_quantity);
    ELSE
      v_missing := v_missing + 1;
    END IF;
  END LOOP;
  
  RETURN QUERY SELECT 
    v_assembly.id,
    v_assembly.file_name,
    v_assembly.part_number,
    v_total,
    v_currency,
    v_component_count,
    v_missing;
END;
$$ LANGUAGE plpgsql STABLE;

-- ===========================================
-- VIEWS FOR ERP INTEGRATION
-- ===========================================

-- View: Parts with pricing summary (for Odoo sync)
CREATE OR REPLACE VIEW parts_with_pricing AS
SELECT 
  f.id,
  f.org_id,
  f.vault_id,
  f.file_path,
  f.file_name,
  f.part_number,
  f.description,
  f.revision,
  f.version,
  f.state,
  f.file_type,
  -- Preferred supplier info
  (
    SELECT jsonb_build_object(
      'supplier_id', s.id,
      'supplier_name', s.name,
      'supplier_code', s.code,
      'supplier_part_number', ps.supplier_part_number,
      'unit_price', ps.unit_price,
      'currency', ps.currency,
      'lead_time_days', COALESCE(ps.lead_time_days, s.default_lead_time_days)
    )
    FROM part_suppliers ps
    JOIN suppliers s ON ps.supplier_id = s.id
    WHERE ps.file_id = f.id AND ps.is_preferred = true AND ps.is_active = true
    LIMIT 1
  ) as preferred_supplier,
  -- Count of suppliers
  (SELECT COUNT(*) FROM part_suppliers WHERE file_id = f.id AND is_active = true) as supplier_count,
  -- Lowest price
  (
    SELECT MIN(unit_price) 
    FROM part_suppliers 
    WHERE file_id = f.id AND is_active = true AND unit_price IS NOT NULL
  ) as lowest_price,
  f.created_at,
  f.updated_at
FROM files f
WHERE f.deleted_at IS NULL
  AND f.part_number IS NOT NULL;

-- ===========================================
-- USAGE EXAMPLES
-- ===========================================

/*
-- Get best price for a part at quantity 100:
SELECT * FROM get_best_price('file-uuid-here', 100);

-- Calculate BOM cost for an assembly:
SELECT * FROM calculate_bom_cost('assembly-uuid-here', 1);

-- List all parts with their preferred supplier and pricing:
SELECT * FROM parts_with_pricing WHERE org_id = 'your-org-id';

-- Find parts without any suppliers:
SELECT f.id, f.part_number, f.file_name
FROM files f
WHERE f.part_number IS NOT NULL
  AND f.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM part_suppliers ps WHERE ps.file_id = f.id);

-- Get all suppliers for a specific part:
SELECT 
  s.name, s.code, 
  ps.supplier_part_number, ps.unit_price, ps.currency,
  ps.price_breaks, ps.lead_time_days, ps.is_preferred
FROM part_suppliers ps
JOIN suppliers s ON ps.supplier_id = s.id
WHERE ps.file_id = 'file-uuid-here'
ORDER BY ps.is_preferred DESC, ps.unit_price ASC;
*/

