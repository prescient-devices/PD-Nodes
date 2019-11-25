import revpimodio2
import sys
def eventfunction(ioname, iovalue):
        #print("Event {} has the value of {}".format(ioname,iovalue))
       print(iovalue)

if len(sys.argv) > 2:
    cmd = sys.argv[1]
    pin_input = sys.argv[2]
    if cmd=="in":
        rpi_in = revpimodio2.RevPiModIO(autorefresh=True,direct_output=True)
        rpi_in.handlesignalend()
        rpi_in.io[pin_input].reg_event(eventfunction)
        rpi_in.mainloop()
    if cmd=="out":
        output_value = sys.argv[3]
        rpi_out = revpimodio2.RevPiModIO(autorefresh=True,direct_output=True)
        rpi_out.io[pin_input].value=int(output_value)
        print(int(output_value))
    else:
        print("cmd not found-something is missing!")

else:
    print("Bad parameters - input_pin")

