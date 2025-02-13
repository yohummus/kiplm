// This file will be injected into the website by the monkey_user_script.js file that the user
// installs in their browser, e.g. via the ViolentMonkey extension.

(function () {
    'use strict';

    // ================================================================================
    // SETUP
    // ================================================================================

    // Base URI for the monkey API; inserted by the KiPLM server
    const API_URL = '/***API_URI***/';

    // Load jQuery and make it local to this script so that it does not interfere with the vendor website
    eval(GM_getResourceText('jquery'));
    const $ = window.jQuery.noConflict(true);

    // Inject the stylesheet; will be inserted by the KiPLM server
    $('head').append(`<style>/***STYLE***/</style>`);

    // Global data object contains information from the website as well as data received
    // from the KiPLM server. The latter will be inserted by the KiPLM server on page load
    // but will also be updated as needed.
    const gd = {
        // Names of the database table (e.g. RES or CON) mapped to the table's column names
        // (e.g. Manufacturer and Resistance)
        db_table_fields: { /***TABLE_FIELDS***/ },

        // List of all IPNs (Internal Part Numbers) in the KiPLM database
        db_ipns: [ /***ALL_IPNS***/ ],

        // The database row for the currently shown part on the website (if any);
        // the information will be column names mapped to the values for the part
        db_part: null,

        // Vendor interface (e.g. MouserVendorInterface) for the currently shown website
        vendor: null,

        // Part information scraped from the website for the currently shown part (if any);
        // same format as db_part
        web_part: null,

        // The promise's resolve() function for the modal button click handlers to call
        // for the currently open modal dialog (if any)
        modal_resolve: null,
    };


    // ================================================================================
    // MAIN FUNCTION
    // ================================================================================
    function main() {

        // Create the vendor interface based on the website URL
        const url = window.location.host;
        if (url.startsWith('www.mouser.') || url.startsWith('eu.mouser.com')) {
            gd.vendor = new MouserVendorInterface();
        } else if (url.startsWith('www.digikey.') || url.startsWith('info.digikey.')) {
            gd.vendor = new DigikeyVendorInterface();
        } else {
            console.error(`Unsupported vendor website: ${url}`);
        }

        // Install an event listener for closing open dropdown menus
        document.documentElement.addEventListener('click', function () {
            $('.kiplm-dropdown').removeClass('kiplm-dropdown-show');
        });
    }


    // ================================================================================
    // KIPLM UI
    // ================================================================================

    function create_ui() {
        const kiplm_ui = $('<div class="kiplm-ui"></div>');
        kiplm_ui.append(create_status_pill());
        kiplm_ui.append(create_add_part_button());
        kiplm_ui.append(create_update_field_button());
        kiplm_ui.append(create_add_part_modal());

        return kiplm_ui;
    }

    async function update_ui() {
        const kiplm_ui = $('.kiplm-ui');
        const spinner = $('.kiplm-status-spinner');
        const status_pill_label = $('.kiplm-status-text');

        spinner.show();
        status_pill_label.text('Loading...');
        status_pill_label.removeProp('title');

        [gd.db_part, gd.db_ipns] = await Promise.all([monkey_api_get_part_by_mpn(gd.web_part['MPN']),
                                                      monkey_api_get_parts()]);
        spinner.hide();

        if (gd.db_part) {
            status_pill_label.text(gd.db_part['IPN']);
            status_pill_label.prop('title', 'IPN (Internal Part Number)');
        }
        else {
            status_pill_label.text('Unknown part');
            status_pill_label.prop('title', 'Part not found in the KiPLM database');
        }

        $('.kiplm-add-part-btn').prop('disabled', gd.db_part !== null);

        // Replace the update field button
        $('.kiplm-update-field-btn-div').remove();
        kiplm_ui.append(create_update_field_button());
        $('.kiplm-update-field-btn').prop('disabled', gd.db_part === null);
    }

    function create_status_pill() {
        const pill = $('<span class="kiplm-status"></span>');
        pill.append('<i class="kiplm-status-spinner fas fa-spinner fa-spin"></i>');
        pill.append('<span class="kiplm-status-text">Loading...</span>');
        return pill;
    }

    function create_add_part_button() {
        return create_button('kiplm-add-part-btn', 'Add part', 'Add this part to the KiPLM database', async () => {
            const prom = new Promise((resolve) => gd.modal_resolve = resolve);
            $('.kiplm-modal').show();
            const ipn = await prom;
            gd.modal_resolve = null;
            
            if (ipn) {
                await monkey_api_post_part(ipn, gd.web_part);
                await update_ui();
            }
        });
    }

    function create_update_field_button() {
        let updatable_fields;
        if (gd.db_part) {
            const table_fields = gd.db_table_fields[gd.db_part['IPN'].substring(0, 3)];
            updatable_fields = Object.keys(gd.web_part).filter((field_name) => table_fields.includes(field_name));
        } else {
            updatable_fields = [];
        }

        return create_button('kiplm-update-field-btn', 'Update field', 'Update a field for this part in the KiPLM database', async (field_name) => {
            await monkey_api_put_part(gd.db_part['IPN'], { [field_name]: gd.web_part[field_name] });
            await update_ui();
        }, updatable_fields);
    }

    function create_button(cls, text, tooltip, async_click_handler, dropdown_items) {
        const btn_div = $(`<div class="kiplm-button-div ${cls}-div"></div>`);
        const btn = $(`<button class="kiplm-button ${cls}" type="button" title="${tooltip}" disabled>${text}</button>`).appendTo(btn_div);
        const spinner = $('<i class="kiplm-button-spinner fas fa-spinner fa-spin"></i>').prependTo(btn).hide();

        // Install the button click handler
        async function run_provided_click_handler(selected_dropdown_item) {
            if (async_click_handler) {
                spinner.show();

                try {
                    await async_click_handler(selected_dropdown_item);
                }
                catch (e) {
                    alert(`ERROR: ${e}`);
                }
                finally {
                    spinner.hide();
                }
            }
        }

        btn.on('click', async function (event) {
            if (dropdown_items) {
                $(`.${cls}-dropdown`).addClass('kiplm-dropdown-show');
                event.stopPropagation();
            }
            else {
                run_provided_click_handler(undefined);
            }
        });

        // Add a dropdown menu if any dropdown items are given
        if (dropdown_items) {
            $('<i class="kiplm-button-caret fas fa-angle-down"></i>').appendTo(btn);
            const dropdown = $(`<div class="kiplm-dropdown ${cls}-dropdown"></div>`).appendTo(btn_div);
            for (const dropdown_item of dropdown_items) {
                const menu_item = $(`<a href="#">${dropdown_item}</a>`).appendTo(dropdown);
                menu_item.on('click', async function (event) {
                    await run_provided_click_handler(dropdown_item);
                });
            }
        }

        return btn_div;
    }

    function create_add_part_modal() {
        const modal = $('<div class="kiplm-modal"></div>');
        const content = $('<div class="kiplm-modal-content"></div>').appendTo(modal);
        content.append('<p class="kiplm-modal-heading">IPN (Internal Part Number):</p>');

        const ipn_container = $('<div class="kiplm-modal-ipn-container"></div>').appendTo(content);
        
        const ccc_input = $('<select class="kiplm-modal-select" title="Category/table name"></select>').appendTo(ipn_container);
        for (const table_name in gd.db_table_fields) {
            ccc_input.append(`<option value="${table_name}">${table_name}</option>`);
        }

        $('<span class="kiplm-ipn-dash">&mdash;</span>').appendTo(ipn_container);
        const nnnn_input = $('<input type="text" class="kiplm-modal-input" placeholder="NNNN" pattern="[0-9]{4}" minLength="4" maxlength="4" title="Incrementing sequential number for each part. Must be exactly 4 digits."></input>').appendTo(ipn_container);
        $('<span class="kiplm-ipn-dash">&mdash;</span>').appendTo(ipn_container);
        const vvvv_input = $('<input type="text" class="kiplm-modal-input" placeholder="VVVV" pattern="[A-Z0-9]{4}" minLength="4" maxlength="4" title="Variation of similar parts typically with the same datasheet (e.g. resistors, capacitors and voltage regulartors). Must be exactly 4 digits and or letters."></input>').appendTo(ipn_container);

        const error_label = $('<div class="kiplm-modal-error-label"><i class="fas fa-exclamation-triangle"></i></div>').appendTo(content);
        const error_text = $('<span class="kiplm-modal-error-text">Fuck this shit</span>').appendTo(error_label);

        const buttons = $('<div class="kiplm-modal-buttons"></div>').appendTo(content);
        const ok_btn = $('<button class="kiplm-button">OK</button>').appendTo(buttons);
        const cancel_btn = $('<button class="kiplm-button">Cancel</button>').appendTo(buttons);

        ok_btn.on('click', () => {
            gd.modal_resolve(`${ccc_input[0].value}-${nnnn_input[0].value}-${vvvv_input[0].value}`);
            modal.hide();
        });

        cancel_btn.on('click', () => {
            gd.modal_resolve(null);
            modal.hide();
        });

        const ipn_re = new RegExp(/^[A-Z]{3}-[0-9]{4}-[a-zA-Z0-9]{4}$/);
        const check_input_fn = () => {
            const ipn = `${ccc_input[0].value}-${nnnn_input[0].value}-${vvvv_input[0].value}`;

            if (!ipn_re.test(ipn)) {
                error_text.text('Invalid IPN');
                error_label.css('visibility', 'visible');
                ok_btn.prop('disabled', true);
            } else if (gd.db_ipns.includes(ipn)) {
                error_text.text('This IPN already exists');
                error_label.css('visibility', 'visible');
                ok_btn.prop('disabled', true);
            } else {
                error_text.text('');
                error_label.css('visibility', 'hidden');
                ok_btn.prop('disabled', false);
            }
        }

        for (const input of [ccc_input, nnnn_input, vvvv_input]) {
            input.on('input', check_input_fn);
        }

        check_input_fn();

        return modal;
    }


    // ================================================================================
    // DEFINITIONS OF VENDOR INTERFACES
    // ================================================================================

    class MouserVendorInterface {
        constructor() {
            this.vendor_name = 'Mouser';

            // Inject the KiPLM UI
            const kiplm_ui = create_ui(this);
            $('.pdp-product-card-header').append(kiplm_ui);
            this.update_web_part();
            update_ui(this);
        }

        update_web_part() {
            const tolerance_raw = this._get_prod_attr('Tolerance');

            let tolerance = null;
            if (tolerance_raw) {
                if (tolerance_raw.includes('%')) {
                    tolerance = fmt_value(tolerance_raw, '%');
                } else if (tolerance_raw.toUpperCase().includes('PPM')) {
                    tolerance = fmt_value(tolerance_raw, 'PPM');
                }
            }

            gd.web_part = {
                'Manufacturer': this._get_prod_attr('Manufacturer'),
                'MPN': $('#spnManufacturerPartNumber').text().trim().replaceAll(' ', ''),
                'Description': $('#spnDescription').text().trim(),
                'Datasheet': $('#pdp-datasheet_0').prop('href'),
                [this.vendor_name + '-PN']: $('#spnMouserPartNumFormattedForProdInfo').text().trim(),
                'Resistance': fmt_value(this._get_prod_attr('Resistance'), 'Ω'),
                'Capacitance': fmt_value(this._get_prod_attr('Capacitance'), 'F'),
                'Inductance': fmt_value(this._get_prod_attr('Inductance'), 'H'),
                'Frequency': fmt_value(this._get_prod_attr('Frequency'), 'Hz'),
                'Frequency Stability': fmt_value(this._get_prod_attr('Frequency Stability'), 'PPM'),
                'Load Capacitance': fmt_value(this._get_prod_attr('Load Capacitance'), 'F'),
                'Voltage': fmt_value(this._get_prod_attr('Voltage Rating'), 'V') || fmt_value(this._get_prod_attr('Voltage Rating DC'), 'V') || fmt_value(this._get_prod_attr('Output Voltage'), 'V'),
                'Current': fmt_value(this._get_prod_attr('Current Rating'), 'A') || fmt_value(this._get_prod_attr('Maximum DC Current'), 'A') || fmt_value(this._get_prod_attr('Output Current'), 'A'),
                'Power': fmt_value(this._get_prod_attr('Power Rating'), 'W'),
                'Tolerance': tolerance,
                'Temperature Coefficient': fmt_value(this._get_prod_attr('Temperature Coefficient'), 'PPM/°C'),
                'Material': this._get_prod_attr('Dielectric'),
                'Package': this._get_prod_attr('Case Code - in'),
                'Pins': fmt_value(this._get_prod_attr('Number of Positions'), ''),
                'Color': this._get_prod_attr('Illumination Color'),
                'Wavelength': fmt_value(this._get_prod_attr('Wavelength/Color Temperature'), 'm'),
                'I-forward-max': fmt_value(this._get_prod_attr('If - Forward Current'), 'A'),
                'V-forward': fmt_value(this._get_prod_attr('Vf - Forward Voltage'), 'V'),
                'Brightness': fmt_value(this._get_prod_attr('Luminous Intensity'), 'cd'),
            };
        }

        _get_prod_attr(product_attribute_name) {
            try {
                const elem = $(`input[name$=NameAndValue][value^="${product_attribute_name}:"]`);
                const text = elem.prop('value').split(':')[1];
                return text;
            } catch (e) {
                return null;
            }
        }
    }

    class DigikeyVendorInterface {
        constructor() {
            this.vendor_name = 'DigiKey';
            this._last_url = '';

            // Watch the URL for changes and insert the KiPLM UI
            setInterval(() => this._check_url_for_changes_and_insert_ui(), 500);
        }

        update_web_part() {
            const is_capacitor = this._get_prod_attr('Category').includes('Capacitors');
            const tolerance_raw = this._get_prod_attr('Tolerance') || this._get_prod_attr('Frequency Tolerance');

            let tolerance = null;
            if (tolerance_raw) {
                if (tolerance_raw.includes('%')) {
                    tolerance = fmt_value(tolerance_raw, '%');
                } else if (tolerance_raw.toUpperCase().includes('PPM')) {
                    tolerance = fmt_value(tolerance_raw, 'PPM');
                }
            }
            
            gd.web_part = {
                'Manufacturer': $('[data-testid="overview-manufacturer"] a').text(),
                'MPN': $('[data-testid="mfr-number"]').text().replaceAll(' ', ''),
                'Description': $('[track-data="ref_page_event=Copy Expand Description"]').text(),
                'Datasheet': $('[data-testid="datasheet-download"]').prop('href'),
                [this.vendor_name + '-PN']: this._get_digikey_part_no(),
                'Resistance': fmt_value(this._get_prod_attr('Resistance'), 'Ω'),
                'Capacitance': fmt_value(this._get_prod_attr('Capacitance'), 'F'),
                'Inductance': fmt_value(this._get_prod_attr('Inductance'), 'H'),
                'Frequency': fmt_value(this._get_prod_attr('Frequency'), 'Hz'),
                'Frequency Stability': fmt_value(this._get_prod_attr('Frequency Stability'), 'PPM'),
                'Load Capacitance': fmt_value(this._get_prod_attr('Load Capacitance'), 'F'),
                'Voltage': fmt_value(this._get_prod_attr('Voltage - Rated'), 'V'),
                'Current': fmt_value(this._get_prod_attr('Current Rating (Amps)'), 'A'),
                'Power': fmt_value(this._get_prod_attr('Power (Watts)'), 'W'),
                'Tolerance': tolerance,
                'Temperature Coefficient': is_capacitor ? null : fmt_value(this._get_prod_attr('Temperature Coefficient'), 'PPM/°C'),
                'Material': is_capacitor ? this._get_prod_attr('Temperature Coefficient') : null,
                'Package': this._get_prod_attr('Supplier Device Package', true),
                'Pins': fmt_value(this._get_prod_attr('Number of Positions'), ''),
                'Color': this._get_prod_attr('Color'),
                'Wavelength': fmt_value(this._get_prod_attr('Wavelength - Dominant'), 'm'),
                'I-forward-max': fmt_value(this._get_prod_attr('Current - Test'), 'A'),
                'V-forward': fmt_value(this._get_prod_attr('Voltage - Forward (Vf) (Typ)'), 'V'),
                'Brightness': fmt_value(this._get_prod_attr('Millicandela Rating'), 'cd'),
            };
        }

        _check_url_for_changes_and_insert_ui() {
            if (this._last_url === window.location.href) return;

            const prod_num_header = $('[class$="mfrProdNumHeader"]');
            if (prod_num_header.length === 0) return;
            if (prod_num_header.find('.kiplm-ui').length > 0) return;

            this.update_web_part();

            const kiplm_ui = create_ui(this);
            prod_num_header.append(kiplm_ui);
            update_ui(this);

            this._last_url = window.location.href;
        }

        _get_digikey_part_no() {
            const elems = $('[track-data="ref_page_event=Copy Report Part Number"]');
            const ct_elems = elems.filter(':contains("Cut Tape")');

            let el;
            if (ct_elems.length > 0) {
                el = ct_elems[0];
            } else if (elems.length > 0) {
                el = elems[0];
            } else {
                return null;
            }

            const text = $(el).text().split(' ')[0];
            return text;
        }

        _get_prod_attr(product_attribute_name, first_word_only) {
            try {
                const elem = $('#product-attributes tr').filter(function () {
                    return $(this).find('div').filter(function () {
                        return $(this).text() === product_attribute_name;
                    }).length > 0;
                }).find('div[class$="-tableCellDescription"]');

                if (elem.length === 0) {
                    return null;
                } else if (first_word_only) {
                    return elem.text().split(' ')[0];
                } else {
                    return elem.text();
                }
            }
            catch (e) {
                return null;
            }
        }
    }


    // ================================================================================
    // HELPER FUNCTIONS
    // ================================================================================

    function fmt_value(raw_str, unit) {
        try {
            let text = raw_str;
            text = text.replace('±', '');
            text = text.replace(' ', '');
            text = text.replace('ppm', 'PPM');
            const [_, val_str, unit_str] = text.match(/(^[0-9\.]+)(.*)/)
            const unit_prefix = 'fpnµumkMGT'.includes(unit_str[0]) ? unit_str[0] : '';
            const space = unit_prefix.startsWith('PPM') ? ' ' : '';
            return `${val_str}${space}${unit_prefix}${unit}`;
        } catch (e) {
            return null;
        }
    }


    // ================================================================================
    // KIPLM MONKEY API
    // ================================================================================

    async function monkey_api_get_parts(mpn) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: API_URL + 'parts',
                method: 'GET',
                responseType: 'json',
                onerror: (resp) => reject(resp.statusText),
                ontimeout: () => reject('Timeout'),
                onload: (resp) => resolve(resp.status == 200 ? resp.response : []),
            });
        });
    }

    async function monkey_api_get_part_by_mpn(mpn) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: API_URL + `part-by-mpn/${mpn}`,
                method: 'GET',
                responseType: 'json',
                onerror: (resp) => reject(resp.statusText),
                ontimeout: () => reject('Timeout'),
                onload: (resp) => resolve(resp.status == 200 ? resp.response : null),
            });
        });
    }

    async function monkey_api_post_part(ipn, part_info) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: API_URL + `part/${ipn}`,
                method: 'POST',
                data: JSON.stringify(part_info),
                responseType: 'json',
                onerror: (resp) => reject(resp.statusText),
                ontimeout: () => reject('Timeout'),
                onload: (resp) => {
                    if (resp.status === 200) {
                        resolve(resp.response);
                    } else {
                        reject(`${resp.status} - ${resp.statusText}`);
                    }
                },
            });
        });
    }

    async function monkey_api_put_part(ipn, part_info) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: API_URL + `part/${ipn}`,
                method: 'PUT',
                data: JSON.stringify(part_info),
                responseType: 'json',
                onerror: (resp) => reject(resp.statusText),
                ontimeout: () => reject('Timeout'),
                onload: (resp) => {
                    if (resp.status === 200) {
                        resolve(resp.response);
                    } else {
                        reject(`${resp.status} - ${resp.statusText}`);
                    }
                },
            });
        });
    }


    // ================================================================================
    main();
})();
